// ==UserScript==
// @name         Sur-mesure Scraper
// @namespace    http://tampermonkey.net/
// @version      5.0
// @description  Intercepts Quotation & CAFR requests. Captures token from CAFR, uses polling to trigger customer detail fetch after Quotation, sends data (with IMAGE formula) to Sheet.
// @match        https://squareclock-internal-sqc-production.k8s.ap.digikfplc.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        unsafeWindow
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @connect      api.kingfisher.com
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    const SCRIPT_NAME = 'Scraper';
    // !!! IMPORTANT: PASTE YOUR GOOGLE APPS SCRIPT WEB APP URL HERE !!!
    const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwpQ-MemAMmvty7od4pVp4S4rJ8Uj0XFur9-QZ-lSYMBlr23p8StyHzWLzzPVhm5LOE/exec';
    // !!! IMPORTANT: PASTE YOUR GOOGLE APPS SCRIPT WEB APP URL HERE !!!

    // Define API types
    const API_TYPES = {
        QUOTATION: 'Quotation',
        CAFR: 'CAFR' // Used for token capture and logging
    };
    const TARGETS = [
        { name: API_TYPES.QUOTATION, url_pattern: '/api/carpentry/Order/Quotation?id=' },
        { name: API_TYPES.CAFR, url_pattern: '/colleague/v2/customers/CAFR' }
    ];
    const CAFR_API_BASE = 'https://api.kingfisher.com/colleague/v2/customers/CAFR';

    // --- Global variables ---
    let latestAuthToken = null; // Stores the latest captured Authorization token
    let pendingCafrData = null; // Stores { customerIdClean, quotationData, vendeurId } for the poller
    let isProcessingCafr = false; // Flag to prevent multiple simultaneous CAFR calls by the poller
    const POLLING_INTERVAL_MS = 500; // Check every 500ms
    let pollingIntervalId = null;

    // --- Google Sheet Communication ---
    function sendDataToSheet(payload) {
        if (!payload) {
            console.warn(`[${SCRIPT_NAME}] No data payload provided to sendDataToSheet.`);
            return;
        }
        if (!GOOGLE_SCRIPT_URL || GOOGLE_SCRIPT_URL === 'PASTE_YOUR_WEB_APP_URL_HERE') {
             console.error(`[${SCRIPT_NAME}] Google Apps Script URL is not set! Cannot send data.`);
             GM_notification({ title: SCRIPT_NAME + " Error", text: "Google Apps Script URL is missing.", timeout: 10000 });
             return;
        }
        console.log(`[${SCRIPT_NAME}] Sending structured data to Google Sheet...`, payload);
        GM_xmlhttpRequest({
            method: "POST",
            url: GOOGLE_SCRIPT_URL,
            data: JSON.stringify(payload),
            headers: { "Content-Type": "application/json" },
            timeout: 30000,
            onload: function(response) {
                try {
                    const responseText = response.responseText.trim();
                    if (!responseText) {
                        console.error(`[${SCRIPT_NAME}] Error sending data. Empty response from Google Sheet.`);
                        GM_notification({ title: SCRIPT_NAME + " Error", text: `Sheet Error: Empty response. Check GAS script.`, timeout: 10000 });
                        return;
                    }
                    const respData = JSON.parse(responseText);
                    if (response.status === 200 && respData.status === 'success') {
                        console.log(`[${SCRIPT_NAME}] Successfully sent data to Google Sheet.`);
                        GM_notification({ title: SCRIPT_NAME, text: `Data sent successfully for ${payload.NomClient || 'N/A'}`, timeout: 4000 });
                    } else {
                        console.error(`[${SCRIPT_NAME}] Error sending data. Status: ${response.status}. Response:`, respData.message || response.responseText);
                        GM_notification({ title: SCRIPT_NAME + " Error", text: `Sheet Error: ${respData.message || 'Check console.'}`, timeout: 10000 });
                    }
                } catch (e) {
                     console.error(`[${SCRIPT_NAME}] Error parsing Google Sheet response. Status: ${response.status}. Response: ${response.responseText}`, e);
                     GM_notification({ title: SCRIPT_NAME + " Error", text: `Sheet response parse error. Check console.`, timeout: 10000 });
                }
            },
            onerror: function(response) {
                console.error(`[${SCRIPT_NAME}] Network error sending data to Google Sheet. Status: ${response.status}. Response:`, response.responseText);
                 GM_notification({ title: SCRIPT_NAME + " Network Error", text: `Network error sending data. Check console.`, timeout: 10000 });
            },
            ontimeout: function() {
                console.error(`[${SCRIPT_NAME}] Timeout sending data to Google Sheet.`);
                 GM_notification({ title: SCRIPT_NAME + " Timeout", text: `Timeout sending data.`, timeout: 10000 });
            }
        });
    }

    // --- Helper: Format Date ---
    function formatDate(isoString) {
        if (!isoString) return '';
        try {
            const date = new Date(isoString);
            const day = String(date.getDate()).padStart(2, '0');
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const year = date.getFullYear();
            return `${day}/${month}/${year}`;
        } catch (e) {
            console.error(`[${SCRIPT_NAME}] Error formatting date: ${isoString}`, e);
            return isoString;
        }
    }

    // --- Structure and Send Final Data ---
    function structureAndSendData(quotationData, customerAttributes, vendeurId) {
        try {
            console.log(`[${SCRIPT_NAME}] Structuring combined data...`);
            let allProductNames = [];
            let firstProductIcon = '';
            let totalDiscountPriceSum = 0;

            if (quotationData && Array.isArray(quotationData.categories)) {
                for (const category of quotationData.categories) {
                    if (category && Array.isArray(category.products)) {
                        for (const product of category.products) {
                            if (product) {
                                allProductNames.push(product.nameFr || product.nameEn || 'Unknown Product');
                                if (firstProductIcon === '' && product.icon) firstProductIcon = product.icon;
                                totalDiscountPriceSum += (parseFloat(product.totalDiscountPv) || 0);
                             }
                        }
                    }
                }
            } else {
                console.warn(`[${SCRIPT_NAME}] Quotation data or categories array missing/invalid during structuring.`);
            }

            const structuredData = {
                Date: formatDate(quotationData?.creationDate),
                NomClient: customerAttributes ? `${customerAttributes.givenName || ''} ${customerAttributes.familyName || ''}`.trim() : 'N/A',
                Telephone: customerAttributes ? (customerAttributes.mobileNumber || customerAttributes.phoneNumber || '') : '',
                Mail: customerAttributes ? (customerAttributes.email || '') : '',
                NumClient: customerAttributes ? (customerAttributes.customerExternalId || 'N/A') : (quotationData?.customerId || 'N/A'),
                PrixTTC: quotationData?.totalPV ?? null,
                PrixRemise: totalDiscountPriceSum,
                Produits: allProductNames.join(', '),
                // Format image URL for Google Sheets
                Image: firstProductIcon ? `=IMAGE("${firstProductIcon}")` : '',
                Vendeur: vendeurId || ''
            };
            sendDataToSheet(structuredData);
        } catch(e) {
             console.error(`[${SCRIPT_NAME}] Error during final data structuring or sending:`, e);
             GM_notification({ title: SCRIPT_NAME + " Error", text: "Error structuring data. Check console.", timeout: 6000 });
        }
    }

    // --- Fetch Specific Customer Details (Uses captured token) ---
    // Called by the polling mechanism
    function fetchCustomerDetails(customerId, quotationData, vendeurId) {
        // --- TOKEN CHECK ---
        if (!latestAuthToken) {
             console.error(`[${SCRIPT_NAME}] Cannot fetch customer details: Authorization token has not been captured from any page CAFR request yet.`);
             GM_notification({ title: SCRIPT_NAME + " Auth Error", text: "Auth token not captured. Customer details skipped.", timeout: 8000 });
             isProcessingCafr = false; // Reset flag
             structureAndSendData(quotationData, null, vendeurId); // Send partial data
             return;
        }
        // --- END TOKEN CHECK ---

        console.log(`[${SCRIPT_NAME}] Polling function triggered fetch for customer: ${customerId} using captured token.`);
        const fetchUrl = `${CAFR_API_BASE}?filter[customerNumber]=${encodeURIComponent(customerId)}&page[number]=1&page[size]=1`;
        const headers = {
            'Accept': 'application/json, text/plain, */*',
            'X-Tenant': 'CAFR',
            'Authorization': latestAuthToken // Use the captured token
        };

        console.log(`[${SCRIPT_NAME}] Preparing GM_xmlhttpRequest (from poll) for URL: ${fetchUrl}`);
        let requestStartTime = Date.now();

        try {
            GM_xmlhttpRequest({
                method: "GET",
                url: fetchUrl,
                headers: headers,
                timeout: 30000,
                onload: function(response) {
                    let duration = Date.now() - requestStartTime;
                    console.log(`[${SCRIPT_NAME}] GM_xmlhttpRequest (poll) - onload triggered after ${duration}ms. Status: ${response.status}`);
                    if (response.status >= 200 && response.status < 300) {
                        console.log(`[${SCRIPT_NAME}] Successfully fetched CAFR details (poll - Status: ${response.status}).`);
                        try {
                            const cafrResponseData = JSON.parse(response.responseText);
                            if (cafrResponseData?.data?.length > 0 && cafrResponseData.data[0].attributes) {
                                console.log(`[${SCRIPT_NAME}] CAFR details found (poll).`, cafrResponseData.data[0].attributes);
                                structureAndSendData(quotationData, cafrResponseData.data[0].attributes, vendeurId);
                            } else {
                                console.warn(`[${SCRIPT_NAME}] Fetched CAFR data (poll), but structure unexpected or empty. Sending partial data. Resp:`, cafrResponseData);
                                GM_notification({ title: SCRIPT_NAME + " Warning", text: `CAFR data missing/invalid for ${customerId}. Partial sent.`, timeout: 8000 });
                                structureAndSendData(quotationData, null, vendeurId);
                            }
                        } catch (e) {
                            console.error(`[${SCRIPT_NAME}] Error parsing fetched CAFR JSON (poll):`, e, response.responseText);
                            GM_notification({ title: SCRIPT_NAME + " Error", text: `CAFR parse error for ${customerId}. Partial sent.`, timeout: 8000 });
                            structureAndSendData(quotationData, null, vendeurId);
                        }
                    } else {
                         if (response.status === 401 || response.status === 403) {
                             console.error(`[${SCRIPT_NAME}] Authentication Error (${response.status}) fetching CAFR (poll). Captured Token might be invalid/expired. Resp:`, response.responseText);
                             GM_notification({ title: SCRIPT_NAME + " CAFR Auth Error", text: `Auth Error ${response.status} (poll). Check token/console.`, timeout: 10000 });
                             // Consider clearing latestAuthToken here? Might cause issues if token source was temporary.
                             // latestAuthToken = null;
                        } else {
                            console.error(`[${SCRIPT_NAME}] Error fetching CAFR details (poll - onload). Status: ${response.status}. Resp:`, response.responseText);
                             GM_notification({ title: SCRIPT_NAME + " CAFR Error", text: `Error ${response.status} fetching CAFR (poll). Partial sent. Check console.`, timeout: 10000 });
                        }
                        structureAndSendData(quotationData, null, vendeurId); // Send partial on any non-2xx status
                    }
                    isProcessingCafr = false; // Reset flag on completion
                },
                onerror: function(response) {
                    let duration = Date.now() - requestStartTime;
                    console.error(`[${SCRIPT_NAME}] GM_xmlhttpRequest (poll) - onerror triggered after ${duration}ms. Status: ${response.status}. Final URL: ${response.finalUrl}`, response);
                    GM_notification({ title: SCRIPT_NAME + " CAFR Network Error", text: `Network error fetching CAFR (poll). Partial sent. Check console.`, timeout: 10000 });
                    isProcessingCafr = false; // Reset flag on error
                    structureAndSendData(quotationData, null, vendeurId);
                 },
                ontimeout: function() {
                    let duration = Date.now() - requestStartTime;
                    console.error(`[${SCRIPT_NAME}] GM_xmlhttpRequest (poll) - ontimeout triggered after ${duration}ms.`);
                    GM_notification({ title: SCRIPT_NAME + " CAFR Timeout", text: `Timeout fetching CAFR (poll). Partial sent.`, timeout: 10000 });
                    isProcessingCafr = false; // Reset flag on error
                    structureAndSendData(quotationData, null, vendeurId);
                },
                onabort: function(response) {
                     let duration = Date.now() - requestStartTime;
                     console.error(`[${SCRIPT_NAME}] GM_xmlhttpRequest (poll) - onabort triggered after ${duration}ms.`, response);
                     GM_notification({ title: SCRIPT_NAME + " CAFR Aborted", text: `Request aborted (poll). Partial sent.`, timeout: 10000 });
                     isProcessingCafr = false; // Reset flag on error
                     structureAndSendData(quotationData, null, vendeurId);
                }
            });
            console.log(`[${SCRIPT_NAME}] GM_xmlhttpRequest (poll) function called. Waiting for callback...`);
        } catch (e) {
             console.error(`[${SCRIPT_NAME}] Error occurred *during* the call to GM_xmlhttpRequest setup (poll):`, e);
             GM_notification({ title: SCRIPT_NAME + " Setup Error", text: `Error setting up CAFR request (poll). Check console.`, timeout: 10000 });
             isProcessingCafr = false; // Reset flag on error
             structureAndSendData(quotationData, null, vendeurId);
        }
    }

    // --- Process Initial Quotation Response ---
    // Stores data for the poller
    function processQuotationResponse(quotationData) {
        try {
            console.log(`[${SCRIPT_NAME}] Processing Quotation response...`);
            const customerIdRaw = quotationData?.customerId;
            const vendeurId = quotationData?.creationUserId;

            if (!quotationData || typeof quotationData !== 'object' || !quotationData.creationDate) {
                 console.error(`[${SCRIPT_NAME}] Invalid or incomplete Quotation data received. Aborting processing.`, quotationData);
                 return;
            }
            if (!customerIdRaw) {
                console.warn(`[${SCRIPT_NAME}] Quotation response missing 'customerId'. Cannot process for CAFR.`, quotationData);
                // Sending partial data immediately if customerId is missing
                 structureAndSendData(quotationData, null, vendeurId);
                return;
            }
            if (!vendeurId) {
                 console.warn(`[${SCRIPT_NAME}] Quotation response missing 'creationUserId'. Vendeur field will be empty.`, quotationData);
            }

            const customerIdClean = customerIdRaw.replace(/^SQ_/, '');

            // Store data for the poller, replacing any existing pending data
             if (!isProcessingCafr) { // Only store if not already processing
                 console.log(`[${SCRIPT_NAME}] Storing data, ready for CAFR fetch poll: Customer ID ${customerIdClean}`);
                 pendingCafrData = { customerIdClean, quotationData: JSON.parse(JSON.stringify(quotationData)), vendeurId };
             } else {
                 console.warn(`[${SCRIPT_NAME}] Ignoring new Quotation response while previous CAFR fetch is processing. Overwriting pending data.`);
                 // Overwrite pending data so the *latest* quote is processed next
                 pendingCafrData = { customerIdClean, quotationData: JSON.parse(JSON.stringify(quotationData)), vendeurId };
             }

            console.log(`[${SCRIPT_NAME}] processQuotationResponse function finished (data stored).`);

        } catch (e) {
            console.error(`[${SCRIPT_NAME}] Error processing quotation data:`, e, quotationData);
        }
    }


    // --- Polling Function ---
    // Checks if data is ready and triggers the fetch
    function checkAndProcessPendingCafr() {
        if (pendingCafrData && !isProcessingCafr) {
            console.log(`[${SCRIPT_NAME}] Poller found pending data. Initiating CAFR fetch.`);
            isProcessingCafr = true; // Set flag BEFORE calling async function

            const dataToProcess = pendingCafrData;
            pendingCafrData = null; // Clear pending state immediately

            try {
                 fetchCustomerDetails(dataToProcess.customerIdClean, dataToProcess.quotationData, dataToProcess.vendeurId);
            } catch(e) {
                 console.error(`[${SCRIPT_NAME}] Synchronous error calling fetchCustomerDetails from poller:`, e);
                 isProcessingCafr = false; // Ensure flag is reset if the call itself fails instantly
            }
        }
    }

    // --- Interception Logic ---

    // Helper to check if a URL matches our target API patterns
    function getTargetMatch(url) {
        if (!url || typeof url !== 'string') return null;
        for (const target of TARGETS) {
            if (url.includes(target.url_pattern)) {
                return target;
            }
        }
        return null;
    }

    // Main function to handle intercepted *Quotation* responses
    async function parseAndProcessQuotationResponse(response) {
        const url = response.url || (response.responseURL);
        console.log(`[${SCRIPT_NAME}] Intercepted ${response.ok ? 'OK' : 'Failed'} response for Quotation from: ${url}`);
        if (!response.ok) {
             console.warn(`[${SCRIPT_NAME}] Ignoring failed Quotation request (${response.status}).`);
             return;
        }
        try {
            const responseClone = response.clone();
            const text = await responseClone.text();
            if (!text || text.trim() === '') {
                 console.warn(`[${SCRIPT_NAME}] Quotation Response (${url}) body is empty. Cannot process.`);
                 return;
            }
            const jsonData = JSON.parse(text);
            processQuotationResponse(jsonData); // Stores data for poller
        } catch (err) {
             const errorText = await response.clone().text();
             if (err instanceof SyntaxError) {
                 console.error(`[${SCRIPT_NAME}] Quotation Response (${url}) is not valid JSON. Snippet:`, errorText.substring(0, 500), err);
             } else {
                 console.error(`[${SCRIPT_NAME}] Error reading/processing Quotation Response body (${url}):`, err, errorText);
             }
        }
    }

    // --- Intercept fetch (Handles Token Capture and Quotation Response) ---
    const originalFetch = unsafeWindow.fetch;
    unsafeWindow.fetch = function(input, init) {
        const url = (typeof input === 'string') ? input : input.url;
        const target = getTargetMatch(url);

        // --- Token Capture Logic (Fetch) ---
        if (target && target.name === API_TYPES.CAFR) {
            console.log(`[${SCRIPT_NAME}] Detected page's ${target.name} fetch request (for token capture):`, url);
            try {
                let headers = init?.headers;
                let currentToken = null;
                if (headers) {
                    if (headers instanceof Headers) {
                        currentToken = headers.get('Authorization');
                    } else if (typeof headers === 'object') {
                        // Find Authorization header case-insensitively
                        const authKey = Object.keys(headers).find(k => k.toLowerCase() === 'authorization');
                        if (authKey) currentToken = headers[authKey];
                    }
                }
                if (currentToken && currentToken.toLowerCase().startsWith('bearer ')) {
                    if (latestAuthToken !== currentToken) {
                         console.log(`[${SCRIPT_NAME}] Captured/Updated Auth Token via fetch request to CAFR.`);
                         latestAuthToken = currentToken;
                    }
                } else if (currentToken) {
                    console.warn(`[${SCRIPT_NAME}] Found Authorization header in CAFR fetch, but it doesn't start with 'Bearer '.`, currentToken.substring(0, 15)+"...");
                } else {
                     // It's okay if some CAFR calls don't have it initially
                    // console.warn(`[${SCRIPT_NAME}] CAFR fetch request detected, but 'Authorization' header not found or empty.`);
                }
            } catch (e) {
                console.error(`[${SCRIPT_NAME}] Error extracting headers from CAFR fetch init:`, e);
            }
        }
        // --- End Token Capture Logic (Fetch) ---
         else if (target && target.name === API_TYPES.QUOTATION) {
             console.log(`[${SCRIPT_NAME}] Detected page's ${target.name} fetch request:`, url);
        }

        // Execute the original fetch
        const promise = originalFetch.apply(this, arguments);

        // --- Quotation Response Handling (Fetch) ---
        if (target && target.name === API_TYPES.QUOTATION) {
            promise.then(response => {
                 (async () => { await parseAndProcessQuotationResponse(response.clone()); })(); // Use clone
                 return response; // Return original response
            }).catch(error => {
                console.error(`[${SCRIPT_NAME}] Network/Fetch Error intercepting ${target.name} (${url}):`, error);
            });
        }
        // --- End Quotation Response Handling (Fetch) ---

        return promise;
    };

    // --- Intercept XMLHttpRequest (Handles Token Capture and Quotation Response) ---
    const originalXhrOpen = unsafeWindow.XMLHttpRequest.prototype.open;
    const originalXhrSend = unsafeWindow.XMLHttpRequest.prototype.send;
    const originalSetRequestHeader = unsafeWindow.XMLHttpRequest.prototype.setRequestHeader;

    // Intercept setRequestHeader for Token Capture
    unsafeWindow.XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
        // Check if it's a CAFR request (target identified in 'open') and the Authorization header
        if (this._target && this._target.name === API_TYPES.CAFR && header.toLowerCase() === 'authorization') {
             if (value && value.toLowerCase().startsWith('bearer ')) {
                if (latestAuthToken !== value) {
                    console.log(`[${SCRIPT_NAME}] Captured/Updated Auth Token via XHR setRequestHeader for CAFR.`);
                    latestAuthToken = value; // Store token globally
                }
             } else if (value) {
                 console.warn(`[${SCRIPT_NAME}] Found Authorization header in CAFR XHR, but doesn't start with 'Bearer '.`, value.substring(0, 15)+"...");
             }
        }
        // Always call the original method
        originalSetRequestHeader.apply(this, arguments);
    };

    // Intercept open to identify target API
    unsafeWindow.XMLHttpRequest.prototype.open = function(method, url) {
        this._requestURL = url;
        this._target = getTargetMatch(url); // Identify if it's CAFR or Quotation
        if (this._target) {
            console.log(`[${SCRIPT_NAME}] Detected page's ${this._target.name} XHR request (open):`, url);
        }
        originalXhrOpen.apply(this, arguments);
    };

    // Intercept send to attach Quotation response handler
    unsafeWindow.XMLHttpRequest.prototype.send = function() {
        const xhr = this;
        const originalOnReadyStateChange = xhr.onreadystatechange;

        if (xhr._target && xhr._target.name === API_TYPES.QUOTATION) {
            xhr.onreadystatechange = function() {
                if (xhr.readyState === 4 && xhr._target && xhr._target.name === API_TYPES.QUOTATION) {
                     const simulatedResponse = { // Create fetch-like response
                        ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, statusText: xhr.statusText,
                        url: xhr.responseURL || xhr._requestURL, text: async () => xhr.responseText,
                        clone: function() { return { ...this }; }
                     };
                     (async () => { await parseAndProcessQuotationResponse(simulatedResponse); })();
                }
                if (originalOnReadyStateChange) originalOnReadyStateChange.apply(this, arguments);
            };
        } else {
             xhr.onreadystatechange = originalOnReadyStateChange;
        }
        originalXhrSend.apply(this, arguments);
    };
    // --- End Interception Logic ---


    // --- Initialize ---
    console.log(`[${SCRIPT_NAME}] v${GM_info.script.version} loaded (runs @ document-idle, dynamic token, polling). Monitoring Quotation & CAFR API.`);
    if (!GOOGLE_SCRIPT_URL || GOOGLE_SCRIPT_URL === 'PASTE_YOUR_WEB_APP_URL_HERE') {
        GM_notification({ title: SCRIPT_NAME + " WARNING", text: `v${GM_info.script.version}: Google Script URL is missing!`, timeout: 10000 });
    } else {
         GM_notification({ title: SCRIPT_NAME, text: `v${GM_info.script.version} Loaded. Ready.`, timeout: 3000 });
    }

    // Start the polling mechanism
    pollingIntervalId = setInterval(checkAndProcessPendingCafr, POLLING_INTERVAL_MS);
    console.log(`[${SCRIPT_NAME}] Polling started (Interval: ${POLLING_INTERVAL_MS}ms).`);

})(); // End of Userscript IIFE

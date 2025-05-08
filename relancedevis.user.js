// ==UserScript==
// @name         Sur-mesure Scraper
// @namespace    http://tampermonkey.net/
// @version      5.3
// @description  Intercepts Quotation & CAFR. Captures token, uses polling for customer details, sends data (with IMAGE formula & QuotationID for de-duplication) to Sheet, shows success/duplicate/loading popups.
// @match        https://squareclock-internal-sqc-production.k8s.ap.digikfplc.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_addStyle
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
    const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwpQ-MemAMmvty7od4pVp4S4rJ8Uj0XFur9-QZ-lSYMBlr23p8StyHzWLzzPVhm5LOE/exec'; // REPLACE WITH YOUR URL
    // !!! IMPORTANT: PASTE YOUR GOOGLE APPS SCRIPT WEB APP URL HERE !!!

    const API_TYPES = {
        QUOTATION: 'Quotation',
        CAFR: 'CAFR'
    };
    const TARGETS = [
        { name: API_TYPES.QUOTATION, url_pattern: '/api/carpentry/Order/Quotation?id=' },
        { name: API_TYPES.CAFR, url_pattern: '/colleague/v2/customers/CAFR' }
    ];
    const CAFR_API_BASE = 'https://api.kingfisher.com/colleague/v2/customers/CAFR';

    let latestAuthToken = null;
    let pendingCafrData = null; // Stores { customerIdClean, quotationData, vendeurId, quotationId }
    let isProcessingCafr = false;
    const POLLING_INTERVAL_MS = 500;
    let pollingIntervalId = null;
    let successPopupTimeoutId = null;
    let loadingPopupElement = null; // For the "Envoi du devis..." popup

    GM_addStyle(`
        #gm-scraper-success-popup {
            position: fixed;
            bottom: 20px;
            right: 20px;
            background-color: #dff0d8; /* Light green background */
            color: #3c763d; /* Dark green text */
            border: 1px solid #d6e9c6; /* Slightly darker border */
            padding: 12px 18px;
            border-radius: 5px;
            box-shadow: 0 2px 5px rgba(0,0,0,0.1);
            z-index: 99999;
            font-family: sans-serif;
            font-size: 18px;
            opacity: 0;
            visibility: hidden;
            transition: opacity 0.4s ease-in-out, visibility 0.4s ease-in-out;
        }
        #gm-scraper-success-popup.visible {
            opacity: 1;
            visibility: visible;
        }
        #gm-scraper-success-popup.duplicate { /* Style for duplicate message */
            background-color: #fcf8e3; /* Light yellow */
            color: #8a6d3b; /* Dark yellow/brown */
            border-color: #faebcc;
        }
        #gm-scraper-loading-popup {
            position: fixed;
            bottom: 20px;
            right: 20px; /* Positioned on the left */
            background-color: #e0e0e0; /* Light greyish blue */
            color: #333; /* Dark grey text */
            border: 1px solid #cccccc;
            padding: 12px 18px;
            border-radius: 5px;
            box-shadow: 0 2px 5px rgba(0,0,0,0.1);
            z-index: 99998; /* Below success popup if they ever overlap */
            font-family: sans-serif;
            font-size: 18px;
            opacity: 0;
            visibility: hidden;
            transition: opacity 0.4s ease-in-out, visibility 0.4s ease-in-out;
        }
        #gm-scraper-loading-popup.visible {
            opacity: 1;
            visibility: visible;
        }
    `);

    function showLoadingPopup(message = "Envoi du devis en cours...") {
        hideLoadingPopup(); // Clear any existing loading popup first

        loadingPopupElement = document.createElement('div');
        loadingPopupElement.id = 'gm-scraper-loading-popup';
        loadingPopupElement.textContent = message;
        document.body.appendChild(loadingPopupElement);

        setTimeout(() => { // Allow DOM update before triggering transition
            if (loadingPopupElement) loadingPopupElement.classList.add('visible');
        }, 10);
    }

    function hideLoadingPopup() {
        if (loadingPopupElement) {
            loadingPopupElement.classList.remove('visible');
            const popupToRemove = loadingPopupElement; // Capture in closure
            setTimeout(() => {
                if (popupToRemove && popupToRemove.parentNode) {
                    popupToRemove.parentNode.removeChild(popupToRemove);
                }
                if (loadingPopupElement === popupToRemove) { // Only nullify if it's the same one
                    loadingPopupElement = null;
                }
            }, 400); // Match transition duration
        }
    }


    function showSuccessPopup(message, duration = 6000, isDuplicate = false) {
        const existingPopup = document.getElementById('gm-scraper-success-popup');
        if (existingPopup) {
            existingPopup.remove();
        }
        if (successPopupTimeoutId) {
            clearTimeout(successPopupTimeoutId);
        }

        const popup = document.createElement('div');
        popup.id = 'gm-scraper-success-popup';
        popup.textContent = message;
        if (isDuplicate) {
            popup.classList.add('duplicate');
        }
        document.body.appendChild(popup);

        setTimeout(() => {
            popup.classList.add('visible');
        }, 10);

        successPopupTimeoutId = setTimeout(() => {
            popup.classList.remove('visible');
            setTimeout(() => {
                if (document.getElementById('gm-scraper-success-popup') === popup) {
                     popup.remove();
                }
            }, 400);
        }, duration);
    }

    function sendDataToSheet(payload) {
        if (!payload) {
            console.warn(`[${SCRIPT_NAME}] No data payload provided to sendDataToSheet.`);
            hideLoadingPopup(); // Hide loading on abort
            return;
        }
        if (!GOOGLE_SCRIPT_URL || GOOGLE_SCRIPT_URL.includes('PASTE_YOUR')) {
             console.error(`[${SCRIPT_NAME}] Google Apps Script URL is not set! Cannot send data.`);
             hideLoadingPopup(); // Hide loading on abort
             GM_notification({ title: SCRIPT_NAME + " Error", text: "Google Apps Script URL is missing.", timeout: 10000 });
             return;
        }
        console.log(`[${SCRIPT_NAME}] Sending structured data to Google Sheet (Quotation ID: ${payload.QuotationId})...`, payload);
        GM_xmlhttpRequest({
            method: "POST",
            url: GOOGLE_SCRIPT_URL,
            data: JSON.stringify(payload),
            headers: { "Content-Type": "application/json" },
            timeout: 30000,
            onload: function(response) {
                hideLoadingPopup(); // Hide loading before showing success/error
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
                        showSuccessPopup("Devis bien envoyé à l'application de relance");
                    } else if (response.status === 200 && respData.status === 'duplicate') {
                        console.log(`[${SCRIPT_NAME}] Data already exists in Google Sheet (duplicate). Quotation ID: ${payload.QuotationId}`);
                        showSuccessPopup("Ce devis est déjà enregistré.", 6000, true); // isDuplicate = true
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
                hideLoadingPopup(); // Hide loading on error
                console.error(`[${SCRIPT_NAME}] Network error sending data. Status: ${response.status}. Resp:`, response.responseText);
                 GM_notification({ title: SCRIPT_NAME + " Network Error", text: `Network error sending. Check console.`, timeout: 10000 });
            },
            ontimeout: function() {
                hideLoadingPopup(); // Hide loading on timeout
                console.error(`[${SCRIPT_NAME}] Timeout sending data to Google Sheet.`);
                 GM_notification({ title: SCRIPT_NAME + " Timeout", text: `Timeout sending data.`, timeout: 10000 });
            }
        });
    }

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

    // Added quotationId parameter
    function structureAndSendData(quotationData, customerAttributes, vendeurId, quotationId) {
        try {
            console.log(`[${SCRIPT_NAME}] Structuring combined data (Quotation ID: ${quotationId})...`);
            let allProductNames = [];
            let firstProductIcon = '';
            let totalDiscountPriceSum = 0;

            if (quotationData && Array.isArray(quotationData.categories)) {
                quotationData.categories.forEach(category => {
                    if (category && Array.isArray(category.products)) {
                        category.products.forEach(product => {
                            if (product) {
                                allProductNames.push(product.nameFr || product.nameEn || 'Unknown Product');
                                if (firstProductIcon === '' && product.icon) firstProductIcon = product.icon;
                                totalDiscountPriceSum += (parseFloat(product.totalDiscountPv) || 0);
                            }
                        });
                    }
                });
            } else {
                console.warn(`[${SCRIPT_NAME}] Quotation data or categories array missing/invalid during structuring.`);
            }

            const structuredData = {
                QuotationId: quotationId || '', // Added Quotation ID
                Date: formatDate(quotationData?.creationDate),
                NomClient: customerAttributes ? `${customerAttributes.givenName || ''} ${customerAttributes.familyName || ''}`.trim() : 'N/A',
                Telephone: customerAttributes ? (customerAttributes.mobileNumber || customerAttributes.phoneNumber || '') : '',
                Mail: customerAttributes ? (customerAttributes.email || '') : '',
                NumClient: customerAttributes ? (customerAttributes.customerExternalId || 'N/A') : (quotationData?.customerId || 'N/A'),
                PrixTTC: quotationData?.totalPV ?? null,
                PrixRemise: totalDiscountPriceSum,
                Produits: allProductNames.join(', '),
                Image: firstProductIcon, // GAS will wrap this with =IMAGE()
                Vendeur: vendeurId || ''
            };
            sendDataToSheet(structuredData);
        } catch(e) {
             console.error(`[${SCRIPT_NAME}] Error during final data structuring or sending (Quotation ID: ${quotationId}):`, e);
             hideLoadingPopup(); // Hide loading if this critical step fails before sendDataToSheet
             GM_notification({ title: SCRIPT_NAME + " Error", text: "Error structuring data. Check console.", timeout: 6000 });
        }
    }

    // Added quotationId parameter
    function fetchCustomerDetails(customerId, quotationData, vendeurId, quotationId) {
        if (!latestAuthToken) {
             console.error(`[${SCRIPT_NAME}] Cannot fetch CAFR: Auth token not captured. Quotation ID: ${quotationId}`);
             GM_notification({ title: SCRIPT_NAME + " Auth Error", text: "Auth token missing. Customer details skipped.", timeout: 8000 });
             isProcessingCafr = false;
             structureAndSendData(quotationData, null, vendeurId, quotationId); // Send partial with quotationId
             return;
        }

        console.log(`[${SCRIPT_NAME}] Polling fetch for customer: ${customerId} (Quotation ID: ${quotationId})`);
        const fetchUrl = `${CAFR_API_BASE}?filter[customerNumber]=${encodeURIComponent(customerId)}&page[number]=1&page[size]=1`;
        const headers = {
            'Accept': 'application/json, text/plain, */*',
            'X-Tenant': 'CAFR',
            'Authorization': latestAuthToken
        };
        let requestStartTime = Date.now();

        GM_xmlhttpRequest({
            method: "GET",
            url: fetchUrl,
            headers: headers,
            timeout: 30000,
            onload: function(response) {
                let duration = Date.now() - requestStartTime;
                console.log(`[${SCRIPT_NAME}] CAFR fetch onload (poll) after ${duration}ms. Status: ${response.status}. Quotation ID: ${quotationId}`);
                try {
                    if (response.status >= 200 && response.status < 300) {
                        const cafrResponseData = JSON.parse(response.responseText);
                        if (cafrResponseData?.data?.length > 0 && cafrResponseData.data[0].attributes) {
                            console.log(`[${SCRIPT_NAME}] CAFR details found (poll).`, cafrResponseData.data[0].attributes);
                            structureAndSendData(quotationData, cafrResponseData.data[0].attributes, vendeurId, quotationId);
                        } else {
                            console.warn(`[${SCRIPT_NAME}] CAFR data (poll) structure unexpected. Sending partial. Resp:`, cafrResponseData);
                            structureAndSendData(quotationData, null, vendeurId, quotationId);
                        }
                    } else {
                        if (response.status === 401 || response.status === 403) console.error(`[${SCRIPT_NAME}] CAFR Auth Error (${response.status}) (poll). Token might be invalid. Resp:`, response.responseText);
                        else console.error(`[${SCRIPT_NAME}] Error fetching CAFR (poll). Status: ${response.status}. Resp:`, response.responseText);
                        structureAndSendData(quotationData, null, vendeurId, quotationId);
                    }
                } catch (e) {
                    console.error(`[${SCRIPT_NAME}] Error parsing CAFR JSON (poll):`, e, response.responseText);
                    structureAndSendData(quotationData, null, vendeurId, quotationId);
                } finally {
                    isProcessingCafr = false;
                }
            },
            onerror: function(response) {
                console.error(`[${SCRIPT_NAME}] CAFR fetch network error (poll). Status: ${response.status}. Quotation ID: ${quotationId}`, response);
                structureAndSendData(quotationData, null, vendeurId, quotationId);
                isProcessingCafr = false;
             },
            ontimeout: function() {
                console.error(`[${SCRIPT_NAME}] CAFR fetch timeout (poll). Quotation ID: ${quotationId}`);
                structureAndSendData(quotationData, null, vendeurId, quotationId);
                isProcessingCafr = false;
            },
            onabort: function(response) {
                 console.error(`[${SCRIPT_NAME}] CAFR fetch aborted (poll). Quotation ID: ${quotationId}`, response);
                 structureAndSendData(quotationData, null, vendeurId, quotationId);
                 isProcessingCafr = false;
            }
        });
    }

    // Added quotationId parameter
    function processQuotationResponse(quotationData, quotationId) {
        try {
            console.log(`[${SCRIPT_NAME}] Processing Quotation response (ID: ${quotationId})...`);
            const customerIdRaw = quotationData?.customerId;
            const vendeurId = quotationData?.creationUserId;

            if (!quotationData || typeof quotationData !== 'object' || !quotationData.creationDate) {
                 console.error(`[${SCRIPT_NAME}] Invalid Quotation data (ID: ${quotationId}). Aborting.`, quotationData);
                 hideLoadingPopup(); // Hide loading on critical error
                 return;
            }
            if (!quotationId) {
                 console.warn(`[${SCRIPT_NAME}] Quotation ID missing during processing. De-duplication by ID will fail.`, quotationData);
            }

            if (!customerIdRaw) {
                console.warn(`[${SCRIPT_NAME}] Quotation missing 'customerId' (ID: ${quotationId}). Sending partial.`, quotationData);
                structureAndSendData(quotationData, null, vendeurId, quotationId);
                return;
            }
            if (!vendeurId) {
                 console.warn(`[${SCRIPT_NAME}] Quotation missing 'creationUserId' (ID: ${quotationId}). Vendeur empty.`, quotationData);
            }

            const customerIdClean = customerIdRaw.replace(/^SQ_/, '');

            const dataToStore = { customerIdClean, quotationData: JSON.parse(JSON.stringify(quotationData)), vendeurId, quotationId };

            if (!isProcessingCafr) {
                 console.log(`[${SCRIPT_NAME}] Storing data for CAFR poll: CustID ${customerIdClean}, QuotID ${quotationId}`);
                 pendingCafrData = dataToStore;
            } else {
                 console.warn(`[${SCRIPT_NAME}] Overwriting pending CAFR data due to new Quotation (ID: ${quotationId}) while previous was processing.`);
                 pendingCafrData = dataToStore;
            }
            console.log(`[${SCRIPT_NAME}] processQuotationResponse finished for Quotation ID: ${quotationId}.`);

        } catch (e) {
            console.error(`[${SCRIPT_NAME}] Error processing quotation data (ID: ${quotationId}):`, e, quotationData);
            hideLoadingPopup(); // Hide loading on critical error
        }
    }

    function checkAndProcessPendingCafr() {
        if (pendingCafrData && !isProcessingCafr) {
            console.log(`[${SCRIPT_NAME}] Poller found pending data. Initiating CAFR fetch for Quotation ID: ${pendingCafrData.quotationId}.`);
            isProcessingCafr = true;

            const dataToProcess = pendingCafrData;
            pendingCafrData = null; // Clear immediately

            try {
                 fetchCustomerDetails(dataToProcess.customerIdClean, dataToProcess.quotationData, dataToProcess.vendeurId, dataToProcess.quotationId);
            } catch(e) {
                 console.error(`[${SCRIPT_NAME}] Sync error calling fetchCustomerDetails from poller (QuotID: ${dataToProcess.quotationId}):`, e);
                 isProcessingCafr = false;
                 if(dataToProcess && dataToProcess.quotationData) {
                     structureAndSendData(dataToProcess.quotationData, null, dataToProcess.vendeurId, dataToProcess.quotationId);
                 } else {
                     hideLoadingPopup(); // If no data to send, ensure loading popup is hidden
                 }
            }
        }
    }

    function getTargetMatch(url) {
        if (!url || typeof url !== 'string') return null;
        for (const target of TARGETS) {
            if (url.includes(target.url_pattern)) {
                return target;
            }
        }
        return null;
    }

    function extractQuotationId(url) {
        if (!url) return null;
        try {
            const urlObj = new URL(url);
            return urlObj.searchParams.get('id');
        } catch (e) {
            const match = url.match(/[?&]id=([^&]+)/);
            if (match && match[1]) {
                return match[1];
            }
            console.warn(`[${SCRIPT_NAME}] Could not extract quotation ID from URL: ${url}`, e);
            return null;
        }
    }

    async function parseAndProcessQuotationResponse(response, quotationId) {
        const url = response.url || (response.responseURL);
        console.log(`[${SCRIPT_NAME}] Intercepted ${response.ok ? 'OK' : 'Failed'} Quotation response (ID: ${quotationId}) from: ${url}`);
        if (!response.ok) {
             console.warn(`[${SCRIPT_NAME}] Ignoring failed Quotation request (${response.status}) (ID: ${quotationId}).`);
             // Do not show loading popup for failed requests
             return;
        }

        showLoadingPopup("Envoi du devis en cours..."); // Show loading popup as processing starts

        try {
            const responseClone = response.clone();
            const text = await responseClone.text();
            if (!text || text.trim() === '') {
                 console.warn(`[${SCRIPT_NAME}] Quotation Response (ID: ${quotationId}, URL: ${url}) body is empty.`);
                 hideLoadingPopup(); // Hide if body is empty
                 return;
            }
            const jsonData = JSON.parse(text);
            processQuotationResponse(jsonData, quotationId);
        } catch (err) {
             hideLoadingPopup(); // Hide loading on parsing error
             const errorText = await response.clone().text().catch(() => "Could not get error text");
             if (err instanceof SyntaxError) {
                 console.error(`[${SCRIPT_NAME}] Quotation Response (ID: ${quotationId}, URL: ${url}) not valid JSON. Snippet:`, errorText.substring(0, 200), err);
             } else {
                 console.error(`[${SCRIPT_NAME}] Error reading Quotation Response body (ID: ${quotationId}, URL: ${url}):`, err, errorText.substring(0,200));
             }
        }
    }

    const originalFetch = unsafeWindow.fetch;
    unsafeWindow.fetch = function(input, init) {
        const url = (typeof input === 'string') ? input : input.url;
        const target = getTargetMatch(url);
        let currentQuotationId = null;

        if (target && target.name === API_TYPES.CAFR) {
            if (init && init.headers) {
                const headers = new Headers(init.headers); // Normalize headers
                const token = headers.get('Authorization');
                if (token && token.toLowerCase().startsWith('bearer ')) {
                    if (latestAuthToken !== token) {
                        console.log(`[${SCRIPT_NAME}] Captured/Updated Auth Token via fetch for CAFR.`);
                        latestAuthToken = token;
                    }
                } else if (token) {
                    console.warn(`[${SCRIPT_NAME}] Non-Bearer Authorization header found for CAFR (fetch): ${token.substring(0,10)}...`);
                }
            }
        } else if (target && target.name === API_TYPES.QUOTATION) {
            currentQuotationId = extractQuotationId(url);
            console.log(`[${SCRIPT_NAME}] Fetch: ${target.name} (ID: ${currentQuotationId || 'N/A'}): ${url.substring(0,100)}...`);
        }

        const promise = originalFetch.apply(this, arguments);

        if (target && target.name === API_TYPES.QUOTATION) {
            promise.then(response => {
                 const responseClone = response.clone();
                 (async () => { await parseAndProcessQuotationResponse(responseClone, currentQuotationId); })();
                 return response;
            }).catch(error => {
                // If fetch itself fails (network error), the loading popup might not have been shown yet, or might need to be hidden if shown by a previous attempt.
                // For simplicity, error logging is primary here. The loading popup is more tied to *successful response processing*.
                console.error(`[${SCRIPT_NAME}] Network/Fetch Error intercepting ${target.name} (ID: ${currentQuotationId}, URL: ${url}):`, error);
            });
        }
        return promise;
    };

    const originalXhrOpen = unsafeWindow.XMLHttpRequest.prototype.open;
    const originalXhrSend = unsafeWindow.XMLHttpRequest.prototype.send;
    const originalSetRequestHeader = unsafeWindow.XMLHttpRequest.prototype.setRequestHeader;

    unsafeWindow.XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
        if (this._target && this._target.name === API_TYPES.CAFR && header.toLowerCase() === 'authorization') {
             if (value && value.toLowerCase().startsWith('bearer ')) {
                if (latestAuthToken !== value) {
                    console.log(`[${SCRIPT_NAME}] Captured/Updated Auth Token via XHR for CAFR.`);
                    latestAuthToken = value;
                }
             } else if (value) {
                console.warn(`[${SCRIPT_NAME}] Non-Bearer Authorization header found for CAFR (XHR): ${value.substring(0,10)}...`);
             }
        }
        originalSetRequestHeader.apply(this, arguments);
    };

    unsafeWindow.XMLHttpRequest.prototype.open = function(method, url) {
        this._requestURL = url;
        this._target = getTargetMatch(url);
        this._quotationId = null;

        if (this._target) {
             if (this._target.name === API_TYPES.QUOTATION) {
                this._quotationId = extractQuotationId(url);
                console.log(`[${SCRIPT_NAME}] XHR Open: ${this._target.name} (ID: ${this._quotationId || 'N/A'}): ${url.substring(0,100)}...`);
            }
        }
        originalXhrOpen.apply(this, arguments);
    };

    unsafeWindow.XMLHttpRequest.prototype.send = function() {
        const xhr = this;
        if (xhr._target && xhr._target.name === API_TYPES.QUOTATION && !xhr._hasScraperListener) {
             const originalOnReadyStateChange = xhr.onreadystatechange;
             xhr._hasScraperListener = true;

             xhr.onreadystatechange = function() {
                if (xhr.readyState === 4 && xhr._target && xhr._target.name === API_TYPES.QUOTATION) {
                     const simulatedResponse = {
                        ok: xhr.status >= 200 && xhr.status < 300,
                        status: xhr.status,
                        statusText: xhr.statusText,
                        url: xhr.responseURL || xhr._requestURL,
                        text: async () => xhr.responseText,
                        clone: function() { return { ...this, text: async () => xhr.responseText }; } // Simple clone for text()
                     };
                     (async () => {
                         try { await parseAndProcessQuotationResponse(simulatedResponse, xhr._quotationId); }
                         catch(e) { console.error(`[${SCRIPT_NAME}] Error in XHR onreadystatechange for Quotation (ID: ${xhr._quotationId}):`, e); }
                     })();
                }
                if (originalOnReadyStateChange) {
                     originalOnReadyStateChange.apply(xhr, arguments);
                }
            };
        }
        originalXhrSend.apply(this, arguments);
    };

    console.log(`[${SCRIPT_NAME}] v${GM_info.script.version} loaded. Monitoring Quotation & CAFR.`);
    if (!GOOGLE_SCRIPT_URL || GOOGLE_SCRIPT_URL.includes('PASTE_YOUR')) {
        GM_notification({ title: SCRIPT_NAME + " WARNING", text: `v${GM_info.script.version}: Google Script URL missing!`, timeout: 10000 });
    } else {
         console.log(`[${SCRIPT_NAME}] Ready. Google Script URL is set.`);
    }

    pollingIntervalId = setInterval(checkAndProcessPendingCafr, POLLING_INTERVAL_MS);
    console.log(`[${SCRIPT_NAME}] Polling started (Interval: ${POLLING_INTERVAL_MS}ms).`);

})();

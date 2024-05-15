// ==UserScript==
// @name         Relance Devis Google Sheets
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Update Google Sheet from web page
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // Function to make the API request
    function testAPI() {

        console.log("Calling API...");
        const url = 'https://qpm-java-api-internal-agce-prod.k8s.ap.digikfplc.com/v1/qpm/quotations?userId=derhan_a&startDate=2024-04-24T00%3a00%3a00.000Z&endDate=2024-05-15T23%3a59%3a59.000Z&pageNumber=1&pageSize=20&sortType=desc&sortField=isUrgent&languageCode=FR&isPrimary=true&deptId=22&quoteStatus=6';

        const headers = {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': 'fr,fr-FR;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
            'Origin': 'https://qpm-web-internal-agce-prod.k8s.ap.digikfplc.com',
            'Priority': 'u=1, i',
            'Referer': 'https://qpm-web-internal-agce-prod.k8s.ap.digikfplc.com/',
            'Sec-Ch-Ua': '"Chromium";v="124", "Microsoft Edge";v="124", "Not-A.Brand";v="99"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"Windows"',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-site'
        };

        fetch(url, {
            method: 'GET',
            headers: headers
        })
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.json();
        })
        .then(data => {
            // Log the API response
            console.log('API Response:', data);

            // Send data to Google Sheets Web App
            sendDataToGoogleSheet(data);
        })
        .catch(error => {
            console.error('Error occurred:', error);
        });
    }

    // Function to send data to Google Sheets
    function sendDataToGoogleSheet(data) {
        const googleWebAppUrl = 'https://script.google.com/macros/s/AKfycbw9Q9f0RYqxN-RPdCaTHAZTJ92GmGpc1_-ptIfUvGSWy9XsCcBOLeUBljEMnCwcTF0aTg/exec';

        fetch(googleWebAppUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        })
        .then(response => response.text())
        .then(result => console.log('Data sent to Google Sheets:', result))
        .catch(error => console.error('Error sending data to Google Sheets:', error));
    }

    // Call the function to make the API request on page load
    window.addEventListener('load', testAPI);
})();

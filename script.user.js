// ==UserScript==
// @name         MG BaseLinker – Weryfikator pobrania
// @namespace    https://github.com/MEGASAM24/tampermonkey-mg
// @version      1.1.0
// @description  Sprawdza poprawność kwot pobrania przy wielu przesyłkach w zamówieniu za pobraniem (BaseLinker API).
// @match        https://panel-g.baselinker.com/orders.php*
// @match        https://panel.baselinker.com/orders.php*
// @updateURL    https://raw.githubusercontent.com/MEGASAM24/tampermonkey-mg/main/script.user.js
// @downloadURL  https://raw.githubusercontent.com/MEGASAM24/tampermonkey-mg/main/script.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      api.baselinker.com
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const API_URL = 'https://api.baselinker.com/connector.php';
    const API_KEY_STORAGE = 'baselinker_api_token';
    const EPSILON = 0.02;
    const DEBOUNCE_MS = 500;
    const CACHE_TTL_MS = 60_000;

    const orderCodCache = new Map();
    let lastAlertKey = '';
    let lastAlertAt = 0;
    let debounceTimer = null;
    let validationRunning = false;
    let lastObservedPackageCount = -1;

    function parsePolishMoney(text) {
        if (!text) return null;
        const normalized = String(text)
            .replace(/\u00a0/g, ' ')
            .replace(/[^\d,.-]/g, '')
            .replace(',', '.');
        const value = parseFloat(normalized);
        return Number.isFinite(value) ? value : null;
    }

    function formatMoney(value) {
        return value.toFixed(2).replace('.', ',') + ' PLN';
    }

    function getApiToken() {
        return GM_getValue(API_KEY_STORAGE, '');
    }

    function promptForApiToken() {
        const current = getApiToken();
        const token = prompt(
            'Weryfikator pobrania MG – podaj klucz API BaseLinker.\n' +
            '(Konto → Moje konto → API)\n\n' +
            'Klucz zostanie zapisany lokalnie w Tampermonkey.',
            current || ''
        );
        if (token && token.trim()) {
            GM_setValue(API_KEY_STORAGE, token.trim());
            return token.trim();
        }
        return current;
    }

    GM_registerMenuCommand('MG: Ustaw klucz API BaseLinker', () => {
        promptForApiToken();
    });

    function blApi(method, parameters) {
        const token = getApiToken();
        if (!token) {
            return Promise.reject(new Error('Brak klucza API BaseLinker'));
        }

        const body = new URLSearchParams({
            method,
            parameters: JSON.stringify(parameters)
        });

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: API_URL,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-BLToken': token
                },
                data: body.toString(),
                onload(response) {
                    try {
                        const data = JSON.parse(response.responseText);
                        if (data.status === 'SUCCESS') {
                            resolve(data);
                        } else {
                            reject(new Error(data.error_message || 'Błąd API BaseLinker'));
                        }
                    } catch (error) {
                        reject(error);
                    }
                },
                onerror() {
                    reject(new Error('Nie udało się połączyć z API BaseLinker'));
                }
            });
        });
    }

    function getCurrentOrderId() {
        const match = (location.hash || '').match(/order:(\d+)/);
        return match ? match[1] : null;
    }

    function isCodOrder() {
        const panel = document.getElementById('pnl_order_info');
        if (!panel) return false;

        const codLabel = panel.querySelector('.label-cod');
        if (codLabel && /tak/i.test(codLabel.textContent.trim())) {
            return true;
        }

        const paymentMethod = panel.querySelector('#oms_info_payment_method');
        return paymentMethod && /pobranie/i.test(paymentMethod.textContent);
    }

    function getOrderTotal() {
        const el = document.getElementById('sale_total_price');
        return el ? parsePolishMoney(el.textContent) : null;
    }

    function getPackageCount() {
        const counter = document.getElementById('table_order_packages_items_counter');
        if (counter && counter.value !== '') {
            const n = parseInt(counter.value, 10);
            if (Number.isFinite(n)) return n;
        }

        const tbody = document.querySelector('#table_order_packages tbody');
        return tbody ? tbody.querySelectorAll('tr').length : 0;
    }

    function getPackageCodFromDetails(detailsResponse) {
        const details = detailsResponse.package_details || [];
        return details.reduce((sum, item) => sum + (Number(item.cod_value) || 0), 0);
    }

    async function fetchOrderCodAmounts(orderId) {
        const domPackageCount = getPackageCount();
        const cacheKey = String(orderId);
        const cached = orderCodCache.get(cacheKey);

        if (
            cached &&
            Date.now() - cached.at < CACHE_TTL_MS &&
            cached.domPackageCount === domPackageCount
        ) {
            return cached.cods;
        }

        const packagesResponse = await blApi('getOrderPackages', {
            order_id: parseInt(orderId, 10)
        });

        const packages = packagesResponse.packages || [];
        const cods = [];

        for (const pkg of packages) {
            const detailsResponse = await blApi('getPackageDetails', {
                package_id: pkg.package_id
            });
            cods.push(getPackageCodFromDetails(detailsResponse));
        }

        orderCodCache.set(cacheKey, {
            cods,
            at: Date.now(),
            domPackageCount
        });

        return cods;
    }

    function findCodInputInForm() {
        const form = document.getElementById('courier_package_form');
        if (!form) return null;

        const candidates = form.querySelectorAll('input[type="text"], input[type="number"], input:not([type])');
        for (const input of candidates) {
            const context = (
                (input.name || '') + ' ' +
                (input.id || '') + ' ' +
                (input.closest('tr')?.textContent || '') + ' ' +
                (input.closest('.form-group')?.textContent || '') + ' ' +
                (form.querySelector(`label[for="${input.id}"]`)?.textContent || '')
            );
            if (/pobranie|cod|cash.?on.?delivery|za pobraniem/i.test(context)) {
                return input;
            }
        }

        for (const row of form.querySelectorAll('tr')) {
            if (!/pobranie/i.test(row.textContent)) continue;
            const input = row.querySelector('input');
            if (input) return input;
        }

        return null;
    }

    function getPendingFormCod() {
        const input = findCodInputInForm();
        if (!input) return 0;
        const value = parsePolishMoney(input.value);
        return value === null ? 0 : value;
    }

    function getSubmitButtons() {
        const container = document.getElementById('courier_package_form_container');
        if (!container) return [];

        return [...container.querySelectorAll('button, input[type="submit"], a.btn')].filter((el) => {
            const text = (el.textContent || el.value || '').toLowerCase();
            return /utwórz|wystaw|nadaj|zapisz|wyślij|wyslij|create|submit/.test(text);
        });
    }

    function showBanner(message, type) {
        let banner = document.getElementById('mg-cod-validator-banner');
        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'mg-cod-validator-banner';
            banner.style.cssText = [
                'position:fixed',
                'top:0',
                'left:0',
                'right:0',
                'z-index:99999',
                'padding:12px 20px',
                'font-size:14px',
                'font-weight:600',
                'text-align:center',
                'box-shadow:0 2px 8px rgba(0,0,0,.25)',
                'font-family:system-ui,sans-serif'
            ].join(';');
            document.body.appendChild(banner);
        }

        if (!message) {
            banner.remove();
            return;
        }

        banner.textContent = message;
        banner.style.background = type === 'error' ? '#c0392b' : '#e67e22';
        banner.style.color = '#fff';
    }

    function showAlertOnce(key, message) {
        const now = Date.now();
        if (key === lastAlertKey && now - lastAlertAt < 5000) return;
        lastAlertKey = key;
        lastAlertAt = now;
        alert(message);
    }

    function isValidDistribution(existingCods, orderTotal) {
        const sum = existingCods.reduce((a, b) => a + b, 0);
        if (Math.abs(sum - orderTotal) <= EPSILON) return true;

        const nonZero = existingCods.filter((v) => v > EPSILON);
        if (nonZero.length === 1 && Math.abs(nonZero[0] - orderTotal) <= EPSILON) {
            return existingCods.every((v) => v <= EPSILON || Math.abs(v - orderTotal) <= EPSILON);
        }

        return false;
    }

    function buildOverLimitMessage(existingSum, pendingCod, projectedSum, orderTotal) {
        return (
            `BŁĄD POBRANIA: Suma kwot pobrania (${formatMoney(projectedSum)}) ` +
            `przekracza wartość zamówienia (${formatMoney(orderTotal)}).\n\n` +
            `Istniejące przesyłki: ${formatMoney(existingSum)}` +
            (pendingCod > EPSILON ? `\nNowa przesyłka (formularz): ${formatMoney(pendingCod)}` : '') +
            `\n\nRozdziel kwotę zamówienia między przesyłki lub ustaw pełną kwotę na jednej przesyłce, a 0 na pozostałych.`
        );
    }

    async function runValidation(triggerAlert) {
        if (validationRunning) return;
        validationRunning = true;

        try {
            const orderId = getCurrentOrderId();
            if (!orderId) {
                showBanner(null);
                return;
            }

            if (!getApiToken()) {
                promptForApiToken();
                if (!getApiToken()) return;
            }

            if (!isCodOrder()) {
                showBanner(null);
                return;
            }

            const orderTotal = getOrderTotal();
            if (orderTotal === null) return;

            const packageCount = getPackageCount();
            const pendingCod = getPendingFormCod();

            let existingCods = [];
            try {
                existingCods = await fetchOrderCodAmounts(orderId);
            } catch (error) {
                console.error('[MG COD Validator]', error);
                showBanner(`Weryfikator pobrania: ${error.message}`, 'warning');
                return;
            }

            const existingSum = existingCods.reduce((a, b) => a + b, 0);
            const projectedSum = existingSum + pendingCod;
            const apiPackageCount = existingCods.length;
            const multiPackage = packageCount >= 2 || apiPackageCount >= 2;

            if (multiPackage) {
                if (projectedSum > orderTotal + EPSILON) {
                    const msg = buildOverLimitMessage(existingSum, pendingCod, projectedSum, orderTotal);
                    showBanner(msg.replace(/\n/g, ' '), 'error');
                    if (triggerAlert) {
                        showAlertOnce(`over-${projectedSum}-${orderTotal}`, msg);
                    }
                    return;
                }

                if (packageCount >= 2 && pendingCod <= EPSILON && !isValidDistribution(existingCods, orderTotal)) {
                    const msg =
                        `UWAGA POBRANIE: Suma kwot na ${packageCount} przesyłkach (${formatMoney(existingSum)}) ` +
                        `nie odpowiada wartości zamówienia (${formatMoney(orderTotal)}).\n\n` +
                        `Sprawdź, czy kwota została poprawnie rozdzielona między przesyłki.`;
                    showBanner(msg.replace(/\n/g, ' '), 'warning');
                    return;
                }
            } else if (projectedSum > orderTotal + EPSILON) {
                const msg =
                    `BŁĄD POBRANIA: Kwota pobrania (${formatMoney(projectedSum)}) ` +
                    `przekracza wartość zamówienia (${formatMoney(orderTotal)}).`;
                showBanner(msg, 'error');
                if (triggerAlert) {
                    showAlertOnce(`over-single-${projectedSum}`, msg);
                }
                return;
            }

            showBanner(null);
        } finally {
            validationRunning = false;
        }
    }

    function scheduleValidation(triggerAlert) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => runValidation(triggerAlert), DEBOUNCE_MS);
    }

    async function onSubmitAttempt(event) {
        if (!isCodOrder()) return;

        const orderId = getCurrentOrderId();
        const orderTotal = getOrderTotal();
        if (!orderId || orderTotal === null) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        const button = event.currentTarget;
        const pendingCod = getPendingFormCod();

        let existingCods = [];
        try {
            existingCods = await fetchOrderCodAmounts(orderId);
        } catch (error) {
            console.error('[MG COD Validator]', error);
            showAlertOnce('api-error', `Nie udało się zweryfikować pobrania: ${error.message}`);
            return;
        }

        const existingSum = existingCods.reduce((a, b) => a + b, 0);
        const projectedSum = existingSum + pendingCod;

        if (projectedSum > orderTotal + EPSILON) {
            const msg = buildOverLimitMessage(existingSum, pendingCod, projectedSum, orderTotal);
            showBanner(msg.replace(/\n/g, ' '), 'error');
            showAlertOnce(`block-${projectedSum}-${orderTotal}`, msg);
            return;
        }

        proceedSubmit(button);
    }

    function proceedSubmit(button) {
        button.dataset.mgCodGuard = '';
        button.removeEventListener('click', onSubmitAttempt, true);
        button.click();
        button.dataset.mgCodGuard = '1';
        button.addEventListener('click', onSubmitAttempt, true);
    }

    function bindSubmitGuards() {
        getSubmitButtons().forEach((button) => {
            if (button.dataset.mgCodGuard) return;
            button.dataset.mgCodGuard = '1';
            button.addEventListener('click', onSubmitAttempt, true);
        });
    }

    function observePage() {
        const targets = [
            document.getElementById('pnl_order_info'),
            document.getElementById('courier_fieldset_content'),
            document.getElementById('courier_package_form_container'),
            document.body
        ].filter(Boolean);

        const observer = new MutationObserver(() => {
            bindSubmitGuards();

            const packageCount = getPackageCount();
            if (packageCount !== lastObservedPackageCount) {
                lastObservedPackageCount = packageCount;
                const orderId = getCurrentOrderId();
                if (orderId) {
                    orderCodCache.delete(String(orderId));
                }
            }

            scheduleValidation(false);
        });

        targets.forEach((target) => {
            observer.observe(target, { childList: true, subtree: true });
        });

        window.addEventListener('hashchange', () => {
            orderCodCache.clear();
            lastObservedPackageCount = -1;
            showBanner(null);
            scheduleValidation(false);
        });

        document.addEventListener('input', (event) => {
            if (event.target.closest('#courier_package_form')) {
                scheduleValidation(false);
            }
        }, true);
    }

    function init() {
        if (!getApiToken()) {
            promptForApiToken();
        }
        bindSubmitGuards();
        observePage();
        lastObservedPackageCount = getPackageCount();
        scheduleValidation(false);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

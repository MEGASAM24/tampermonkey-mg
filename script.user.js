// ==UserScript==
// @name         Tampermonkey MG
// @namespace    https://github.com/MEGASAM24/tampermonkey-mg
// @version      1.2.0
// @description  Tampermonkey MG
// @match        *://panel-g.baselinker.com/*
// @match        *://panel.baselinker.com/*
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

    if (!/\/orders\.php/.test(location.pathname)) {
        return;
    }

    console.log('[COD verify] skrypt uruchomiony na', location.href);

    function showActiveBadge() {
        if (document.getElementById('mg-cod-active-badge')) return;
        const badge = document.createElement('div');
        badge.id = 'mg-cod-active-badge';
        badge.textContent = 'Tampermonkey MG';
        badge.style.cssText = 'position:fixed;bottom:42px;right:12px;z-index:99998;padding:3px 7px;background:#2ecc71;color:#fff;font:10px system-ui;border-radius:3px;opacity:.85';
        document.documentElement.appendChild(badge);
    }

    const API_URL = 'https://api.baselinker.com/connector.php';
    const API_KEY_STORAGE = 'baselinker_api_token';
    const EPSILON = 0.02;
    const DEBOUNCE_MS = 500;
    const CACHE_TTL_MS = 60_000;

    const orderCodCache = new Map();
    const orderInfoCache = new Map();
    let debounceTimer = null;
    let validationRunning = false;
    let lastObservedPackageCount = -1;
    let modalDismissedForOrderId = null;

    function parsePolishMoney(text) {
        if (!text) return null;
        const normalized = String(text)
            .replace(/\u00a0/g, ' ')
            .replace(/[^\d,.-]/g, '')
            .replace(',', '.');
        const value = parseFloat(normalized);
        return Number.isFinite(value) ? value : null;
    }

    function formatMoney(value, currency) {
        return value.toFixed(2).replace('.', ',') + ' ' + currency;
    }

    function computeOrderTotalFromApi(order) {
        const productsTotal = (order.products || []).reduce(
            (sum, p) => sum + (Number(p.price_brutto) || 0) * (Number(p.quantity) || 0),
            0
        );
        return productsTotal + (Number(order.delivery_price) || 0);
    }

    async function fetchOrderInfo(orderId) {
        const key = String(orderId);
        const cached = orderInfoCache.get(key);
        if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
            return cached;
        }

        const response = await blApi('getOrders', {
            order_id: parseInt(orderId, 10)
        });

        const order = response.orders && response.orders[0];
        if (!order) {
            throw new Error('Nie znaleziono zamówienia w API');
        }

        const info = {
            currency: String(order.currency || 'PLN').toUpperCase(),
            total: computeOrderTotalFromApi(order),
            at: Date.now()
        };

        orderInfoCache.set(key, info);
        return info;
    }

    async function getOrderInfo(orderId) {
        try {
            return await fetchOrderInfo(orderId);
        } catch (error) {
            console.error('[MG COD Validator] getOrders:', error);
            const el = document.getElementById('sale_total_price');
            const domTotal = el ? parsePolishMoney(el.textContent) : null;
            if (domTotal === null) throw error;
            return {
                currency: 'PLN',
                total: domTotal,
                at: Date.now()
            };
        }
    }

    function getApiToken() {
        return GM_getValue(API_KEY_STORAGE, '');
    }

    function showApiKeyModal() {
        if (document.getElementById('mg-cod-api-modal')) return;

        const overlay = document.createElement('div');
        overlay.id = 'mg-cod-api-modal';
        overlay.style.cssText = [
            'position:fixed', 'inset:0', 'z-index:100000',
            'background:rgba(0,0,0,.55)', 'display:flex',
            'align-items:center', 'justify-content:center',
            'font-family:system-ui,sans-serif'
        ].join(';');

        overlay.innerHTML = `
            <div style="background:#fff;border-radius:8px;padding:24px;max-width:480px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,.3)">
                <h3 style="margin:0 0 12px;font-size:18px">COD verify</h3>
                <p style="margin:0 0 16px;color:#444;font-size:14px;line-height:1.5">
                    Podaj token<br>
                
                </p>
                <input id="mg-cod-api-input" type="password" placeholder="Token"
                    style="width:100%;padding:10px;border:1px solid #ccc;border-radius:4px;font-size:14px;box-sizing:border-box" />
                <div style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end">
                    <button id="mg-cod-api-save" style="padding:8px 16px;background:#2ecc71;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:600">
                        Zapisz
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        const input = overlay.querySelector('#mg-cod-api-input');
        const saveBtn = overlay.querySelector('#mg-cod-api-save');
        const existing = getApiToken();
        if (existing) input.value = existing;

        saveBtn.addEventListener('click', () => {
            const token = input.value.trim();
            if (!token) {
                input.style.borderColor = '#c0392b';
                return;
            }
            GM_setValue(API_KEY_STORAGE, token);
            overlay.remove();
            scheduleValidation(false);
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') saveBtn.click();
        });

        input.focus();
    }

    function promptForApiToken() {
        showApiKeyModal();
        return getApiToken();
    }

    GM_registerMenuCommand('Ustaw klucz API BaseLinker', () => {
        const existing = document.getElementById('mg-cod-api-modal');
        if (existing) existing.remove();
        showApiKeyModal();
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

    function isElementVisible(el) {
        if (!el || !el.isConnected) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return el.getClientRects().length > 0;
    }

    function isCourierFormOpen() {
        const form = document.getElementById('courier_package_form');
        if (!form || !form.textContent.trim()) return false;
        return isElementVisible(form);
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
        if (!isCourierFormOpen()) return 0;

        const input = findCodInputInForm();
        if (!input || !isElementVisible(input)) return 0;

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

    function hideErrorModal() {
        document.getElementById('mg-cod-error-modal')?.remove();
    }

    function showErrorModal(message, orderId) {
        if (String(orderId) === String(modalDismissedForOrderId)) return;
        if (document.getElementById('mg-cod-error-modal')) return;

        const overlay = document.createElement('div');
        overlay.id = 'mg-cod-error-modal';
        overlay.style.cssText = [
            'position:fixed', 'inset:0', 'z-index:100001',
            'background:rgba(0,0,0,.55)', 'display:flex',
            'align-items:center', 'justify-content:center',
            'font-family:system-ui,sans-serif'
        ].join(';');

        overlay.innerHTML = `
            <div style="background:#fff;border-radius:8px;padding:24px;max-width:520px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,.3)">
                <h3 style="margin:0 0 16px;font-size:18px;color:#c0392b">Błąd pobrania</h3>
                <div id="mg-cod-error-modal-text" style="margin:0 0 20px;color:#333;font-size:14px;line-height:1.6;white-space:pre-line"></div>
                <div style="display:flex;justify-content:flex-end">
                    <button id="mg-cod-error-modal-ok" style="padding:8px 20px;background:#c0392b;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:600;font-size:14px">
                        OK
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);
        overlay.querySelector('#mg-cod-error-modal-text').textContent = message;

        overlay.querySelector('#mg-cod-error-modal-ok').addEventListener('click', () => {
            modalDismissedForOrderId = String(orderId);
            overlay.remove();
        });
    }

    function showOrderCodError(orderId, message) {
        showBanner(message.replace(/\n/g, ' '), 'error');
        showErrorModal(message, orderId);
    }

    function showOrderCodWarning(message) {
        hideErrorModal();
        showBanner(message.replace(/\n/g, ' '), 'warning');
    }

    function clearCodError() {
        hideErrorModal();
        showBanner(null);
    }

    function resetOrderErrorState() {
        modalDismissedForOrderId = null;
        clearCodError();
    }

    function classifyCodIssue(existingSum, pendingCod, projectedSum, orderTotal) {
        if (projectedSum <= orderTotal + EPSILON) return 'ok';
        if (existingSum > orderTotal + EPSILON) return 'error';
        if (pendingCod > EPSILON && isCourierFormOpen()) return 'warning';
        return 'error';
    }

    function buildOverLimitErrorMessage(existingSum, pendingCod, projectedSum, orderTotal, currency) {
        const lines = [
            `BŁĄD POBRANIA: Suma kwot pobrania (${formatMoney(projectedSum, currency)}) ` +
            `przekracza wartość zamówienia (${formatMoney(orderTotal, currency)}).`,
            '',
            `Istniejące przesyłki: ${formatMoney(existingSum, currency)}`
        ];
        if (pendingCod > EPSILON) {
            lines.push(`Nowa przesyłka: ${formatMoney(pendingCod, currency)}`);
        }
        lines.push(
            '',
            'Rozdziel kwotę zamówienia między przesyłki lub ustaw pełną kwotę na jednej przesyłce, a 0 na pozostałych.'
        );
        return lines.join('\n');
    }

    function buildOverLimitWarningMessage(existingSum, pendingCod, projectedSum, orderTotal, currency) {
        return (
            `OSTRZEŻENIE: Jeśli wystawisz przesyłkę bez zmiany kwoty pobrania, suma przekroczy wartość zamówienia.\n\n` +
            `Istniejące przesyłki: ${formatMoney(existingSum, currency)}\n` +
            `Kwota w formularzu: ${formatMoney(pendingCod, currency)}\n` +
            `Suma po wystawieniu: ${formatMoney(projectedSum, currency)} (limit: ${formatMoney(orderTotal, currency)})\n\n` +
            `Popraw kwotę pobrania w formularzu przed wystawieniem przesyłki.`
        );
    }

    function buildSubmitBlockedMessage(existingSum, pendingCod, projectedSum, orderTotal, currency) {
        return (
            `BŁĄD POBRANIA: Nie można wystawić przesyłki — suma kwot pobrania (${formatMoney(projectedSum, currency)}) ` +
            `przekracza wartość zamówienia (${formatMoney(orderTotal, currency)}).\n\n` +
            `Istniejące przesyłki: ${formatMoney(existingSum, currency)}\n` +
            `Nowa przesyłka: ${formatMoney(pendingCod, currency)}\n\n` +
            `Popraw kwotę pobrania przed wystawieniem.`
        );
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

    async function runValidation(triggerAlert) {
        if (validationRunning) return;
        validationRunning = true;

        try {
            const orderId = getCurrentOrderId();
            if (!orderId) {
                clearCodError();
                return;
            }

            if (!getApiToken()) {
                promptForApiToken();
                if (!getApiToken()) return;
            }

            if (!isCodOrder()) {
                clearCodError();
                return;
            }

            const pendingCod = getPendingFormCod();

            let orderInfo;
            let existingCods = [];
            try {
                orderInfo = await getOrderInfo(orderId);
                existingCods = await fetchOrderCodAmounts(orderId);
            } catch (error) {
                console.error('[MG COD Validator]', error);
                showBanner(`Weryfikator pobrania: ${error.message}`, 'warning');
                return;
            }

            const orderTotal = orderInfo.total;
            const currency = orderInfo.currency;

            const existingSum = existingCods.reduce((a, b) => a + b, 0);
            const projectedSum = existingSum + pendingCod;

            const issue = classifyCodIssue(existingSum, pendingCod, projectedSum, orderTotal);

            if (issue === 'error') {
                const msg = buildOverLimitErrorMessage(existingSum, pendingCod, projectedSum, orderTotal, currency);
                showOrderCodError(orderId, msg);
                return;
            }

            if (issue === 'warning') {
                const msg = buildOverLimitWarningMessage(existingSum, pendingCod, projectedSum, orderTotal, currency);
                showOrderCodWarning(msg);
                return;
            }

            clearCodError();
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
        if (!orderId) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        const button = event.currentTarget;
        const pendingCod = getPendingFormCod();

        let orderInfo;
        let existingCods = [];
        try {
            orderInfo = await getOrderInfo(orderId);
            existingCods = await fetchOrderCodAmounts(orderId);
        } catch (error) {
            console.error('[MG COD Validator]', error);
            showBanner(`Weryfikator pobrania: ${error.message}`, 'warning');
            return;
        }

        const orderTotal = orderInfo.total;
        const currency = orderInfo.currency;

        const existingSum = existingCods.reduce((a, b) => a + b, 0);
        const projectedSum = existingSum + pendingCod;

        const blocksShipment =
            pendingCod > EPSILON && projectedSum > orderTotal + EPSILON;

        if (blocksShipment) {
            const msg = buildSubmitBlockedMessage(existingSum, pendingCod, projectedSum, orderTotal, currency);
            showBanner(msg.replace(/\n/g, ' '), 'error');
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

    // --- Filtrowanie kurierów wg źródła zamówienia ---

    const COURIER = {
        allegro: 'allegrokurier',
        temu: 'temu_shipping',
        noweKolory: 'nowekolory',
        furgonetka: 'furgonetka',
        blpaczka: 'blpaczka',
        paczkomaty: 'paczkomaty',
        inpostKurier: 'inpostkurier'
    };

    const TEMU_NK_COUNTRY_CODES = new Set(['RO', 'BG', 'HU']);
    const TEMU_NK_COUNTRY_NAMES = /rumunia|romania|bułgaria|bulgaria|węgry|hungary/i;

    let courierFilterTimer = null;

    function ensureCourierFilterStyles() {
        if (document.getElementById('mg-courier-filter-style')) return;
        const style = document.createElement('style');
        style.id = 'mg-courier-filter-style';
        style.textContent = '#order_packages_courier_buttons .mg-courier-filter-hide{display:none!important}';
        document.documentElement.appendChild(style);
    }

    function getOrderSourceText() {
        return document.getElementById('oms_info_order_from')?.textContent?.trim() || '';
    }

    function getDeliveryCountryCode() {
        const code = document.getElementById('oms_delivery_delivery_country_code')?.value?.trim();
        if (code) return code.toUpperCase();

        const name = document.getElementById('oms_delivery_delivery_country')?.textContent?.trim() || '';
        if (/rumunia|romania/i.test(name)) return 'RO';
        if (/bułgaria|bulgaria/i.test(name)) return 'BG';
        if (/węgry|hungary/i.test(name)) return 'HU';
        return '';
    }

    function isTemuNkCountry() {
        const code = getDeliveryCountryCode();
        if (TEMU_NK_COUNTRY_CODES.has(code)) return true;
        const name = document.getElementById('oms_delivery_delivery_country')?.textContent?.trim() || '';
        return TEMU_NK_COUNTRY_NAMES.test(name);
    }

    function getDeliveryMethodText() {
        return document.getElementById('oms_info_delivery_method')?.textContent?.trim() || '';
    }

    function resolveAllowedCourierNames(source) {
        if (!source) return null;

        if (source.includes('(Base)')) return [];

        if (source.includes('(InPost Von Halsky)')) {
            return getDeliveryMethodText().includes('Paczkomat')
                ? [COURIER.paczkomaty]
                : [COURIER.inpostKurier];
        }

        if (source.includes('{Temu}')) {
            return [isTemuNkCountry() ? COURIER.noweKolory : COURIER.temu];
        }

        if (/\(eMAG\.ro\)|\(eMAG\.bg\)|\(eMAG\.hu\)/i.test(source)) {
            return [COURIER.noweKolory];
        }

        if (source.includes('(Allegro)')) return [COURIER.allegro];
        if (source.includes('(Sklep int.)')) return [COURIER.furgonetka];
        if (source.includes('(Kaufland)')) return [COURIER.furgonetka];
        if (/Amazon/i.test(source)) return [COURIER.blpaczka];

        return null;
    }

    function rememberCourierButtonState(btn) {
        if (btn.dataset.mgCourierOriginalHide !== undefined) return;
        btn.dataset.mgCourierOriginalHide = btn.classList.contains('hide') ? '1' : '0';
    }

    function restoreCourierButtonState(btn) {
        btn.classList.remove('mg-courier-filter-hide');
        btn.style.removeProperty('display');
        if (btn.dataset.mgCourierOriginalHide === '1') {
            btn.classList.add('hide');
        } else {
            btn.classList.remove('hide');
        }
    }

    function setCourierButtonVisible(btn, visible) {
        rememberCourierButtonState(btn);
        if (visible) {
            btn.classList.remove('mg-courier-filter-hide', 'hide');
            btn.style.removeProperty('display');
        } else {
            btn.classList.add('mg-courier-filter-hide');
            btn.style.display = 'none';
        }
    }

    function applyCourierFilter() {
        const container = document.getElementById('order_packages_courier_buttons');
        if (!container) return;

        ensureCourierFilterStyles();

        const allowed = resolveAllowedCourierNames(getOrderSourceText());
        const buttons = container.querySelectorAll('[id^="courier_"][data-courier-name]');
        const toggleBtn = container.querySelector('button');

        if (allowed === null) {
            buttons.forEach((btn) => restoreCourierButtonState(btn));
            if (toggleBtn) {
                toggleBtn.classList.remove('mg-courier-filter-hide');
                toggleBtn.style.removeProperty('display');
            }
            return;
        }

        const allowedSet = new Set(allowed);

        buttons.forEach((btn) => {
            const name = btn.getAttribute('data-courier-name');
            setCourierButtonVisible(btn, allowedSet.has(name));
        });

        if (toggleBtn) {
            const hideToggle = allowed.length === 0 || allowed.length < buttons.length;
            if (hideToggle) {
                toggleBtn.classList.add('mg-courier-filter-hide');
                toggleBtn.style.display = 'none';
            } else {
                toggleBtn.classList.remove('mg-courier-filter-hide');
                toggleBtn.style.removeProperty('display');
            }
        }
    }

    function scheduleCourierFilter() {
        clearTimeout(courierFilterTimer);
        courierFilterTimer = setTimeout(applyCourierFilter, 100);
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
            document.getElementById('order_packages_courier_buttons'),
            document.getElementById('oms_delivery_container'),
            document.body
        ].filter(Boolean);

        const observer = new MutationObserver(() => {
            bindSubmitGuards();
            scheduleCourierFilter();

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
            orderInfoCache.clear();
            lastObservedPackageCount = -1;
            resetOrderErrorState();
            scheduleCourierFilter();
            if (!getApiToken()) {
                showApiKeyModal();
            }
            scheduleValidation(false);
        });

        document.addEventListener('input', (event) => {
            if (event.target.closest('#courier_package_form')) {
                scheduleValidation(false);
            }
        }, true);
    }

    function init() {
        showActiveBadge();
        ensureCourierFilterStyles();
        if (!getApiToken()) {
            promptForApiToken();
        }
        bindSubmitGuards();
        observePage();
        lastObservedPackageCount = getPackageCount();
        scheduleCourierFilter();
        scheduleValidation(false);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

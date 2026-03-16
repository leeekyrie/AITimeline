(function () {
    if (window.__ait_net_installed__) return;
    window.__ait_net_installed__ = true;

    var MSG_TYPE = '__ait_net_capture__';
    var FLUSH_TYPE = '__ait_net_flush__';
    var buffer = [];
    var urlFilter = /\/(api|samantha|alice)\//i;

    function bodyStr(b) {
        if (!b) return '';
        if (typeof b === 'string') return b;
        try { return JSON.stringify(b); } catch (e) { return ''; }
    }

    function dispatch(url, body, text) {
        if (!text || text.length < 3) return;
        if (!urlFilter.test(url)) return;
        var entry = { url: url, body: body, text: text };
        if (buffer.length > 50) buffer.splice(0, buffer.length - 50);
        buffer.push(entry);
        try {
            window.postMessage({ type: MSG_TYPE, payload: entry }, '*');
        } catch (e) {}
    }

    window.addEventListener('message', function (e) {
        if (e.data && e.data.type === FLUSH_TYPE) {
            for (var i = 0; i < buffer.length; i++) {
                try {
                    window.postMessage({ type: MSG_TYPE, payload: buffer[i] }, '*');
                } catch (ex) {}
            }
        }
    });

    var origFetch = window.fetch;
    window.fetch = function () {
        var args = arguments;
        var url = (args[0] && args[0] instanceof Request) ? args[0].url : String(args[0] || '');
        var body = (args[0] instanceof Request) ? '' : bodyStr(args[1] && args[1].body);
        return origFetch.apply(this, args).then(function (resp) {
            try {
                resp.clone().text().then(function (t) { dispatch(url, body, t); }).catch(function () {});
            } catch (e) {}
            return resp;
        });
    };

    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    var xhrMap = new WeakMap();

    XMLHttpRequest.prototype.open = function (m, u) {
        xhrMap.set(this, String(u || ''));
        return origOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function () {
        var xhr = this;
        var xUrl = xhrMap.get(this) || '';
        var body = bodyStr(arguments[0]);
        xhr.addEventListener('load', function () {
            if (xhr.readyState === 4 && xhr.status >= 200 && xhr.status < 300) {
                try { dispatch(xUrl, body, xhr.responseText); } catch (e) {}
            }
        });
        return origSend.apply(this, arguments);
    };
})();

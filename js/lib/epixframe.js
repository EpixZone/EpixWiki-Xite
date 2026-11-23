(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports) :
  typeof define === 'function' && define.amd ? define(['exports'], factory) :
  (global = typeof globalThis !== 'undefined' ? globalThis : global || self, factory(global.EpixFrameModule = {}));
})(this, (function (exports) { 'use strict';

  /**
   * EpixFrame  - Unified communication library for EpixNet sites.
   *
   * Provides the iframe <-> wrapper postMessage bridge, convenience methods
   * for every EpixNet API command, and a minimal EventEmitter.
   *
   * Usage:
   *   Script tag:  window.EpixFrame (constructor), window.epixFrame (singleton)
   *   ES module:   import { EpixFrame, epixFrame } from './js/lib/epixframe.esm.js'
   *                (epixFrame is the shared instance; epixFrame() also returns it)
   *   CoffeeScript: class MyApp extends EpixFrame
   *
   * @license MIT
   * @version 1.1.1
   */

  // `u` (a URL) with the xite's ajax_key appended to its query, before any
  // fragment.
  function withKey(u, key) {
    var hash = u.hash;
    var bare = u.href.slice(0, u.href.length - hash.length);
    var sep = '?';
    if (u.search) sep = '&';
    else if (bare.charAt(bare.length - 1) === '?') sep = '';
    return bare + sep + 'ajax_key=' + encodeURIComponent(key) + hash;
  }

  class EpixFrame {
    constructor(url) {
      this.url = url || null;
      this._target = null;
      this._wrapperNonce = null;
      this._nextId = 1;
      this._waitingCb = {};
      this._listeners = {};
      this._historyState = {};
      this._connected = false;
      this._ajaxKey = null;

      // For CoffeeScript compat  - waiting_cb accessible
      this.waiting_cb = this._waitingCb;
      this.next_message_id = this._nextId;
      this.history_state = this._historyState;

      // Extract nonce from URL
      this._wrapperNonce = this._extractNonce();
      this.wrapper_nonce = this._wrapperNonce;

      // Connect to wrapper
      if (typeof window !== 'undefined') {
        this._connect();
      }

      // Overridable init hook
      this.init();
    }

    // ---------------------------------------------------------------------------
    // Overridable hooks (CoffeeScript subclass pattern)
    //
    // The matching on() events ('openWebsocket', 'closeWebsocket', 'request')
    // are emitted by the message handler right after the hook runs, so a
    // subclass may override a hook without calling super and on() listeners
    // still fire.
    // ---------------------------------------------------------------------------

    init() {
      return this;
    }

    onOpenWebsocket() {
      this.log('Websocket open');
    }

    onCloseWebsocket() {
      this.log('Websocket close');
    }

    onRequest(cmd, message) {
      this.log('Unknown request', cmd, message);
    }

    // ---------------------------------------------------------------------------
    // Core communication
    // ---------------------------------------------------------------------------

    /**
     * Send a command to the EpixNet wrapper.
     *
     * Calling conventions:
     *   cmd('name')                    → Promise
     *   cmd('name', params)            → Promise
     *   cmd('name', callback)          → void (callback style)
     *   cmd('name', params, callback)  → void (callback style)
     */
    cmd(cmd, params, cb) {
      if (typeof params === 'function') {
        cb = params;
        params = {};
      }
      if (params == null) {
        params = {};
      }

      var message = { cmd: cmd, params: params };

      if (cb) {
        this._send(message, cb);
      } else {
        var self = this;
        return new Promise(function (resolve, reject) {
          self._send(message, null, resolve, reject);
        });
      }
    }

    /**
     * Respond to a wrapper request.
     */
    response(to, result) {
      this._sendRaw({
        cmd: 'response',
        to: to,
        result: result
      });
    }

    /**
     * Log with [ClassName] prefix (replaces CoffeeScript Class.log).
     * Subclasses automatically get their own name, e.g. [EpixTalk].
     */
    log() {
      var args = ['[' + this.constructor.name + ']'];
      for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
      console.log.apply(console, args);
    }

    logStart(name) {
      if (!this._logTimers) this._logTimers = {};
      this._logTimers[name] = Date.now();
      if (arguments.length > 1) {
        var args = [name];
        for (var i = 1; i < arguments.length; i++) args.push(arguments[i]);
        args.push('(started)');
        this.log.apply(this, args);
      }
    }

    logEnd(name) {
      var ms = Date.now() - (this._logTimers && this._logTimers[name] || 0);
      var args = [name];
      for (var i = 1; i < arguments.length; i++) args.push(arguments[i]);
      args.push('(Done in ' + ms + 'ms)');
      this.log.apply(this, args);
    }

    // ---------------------------------------------------------------------------
    // Event system
    // ---------------------------------------------------------------------------

    on(event, fn) {
      if (!this._listeners[event]) this._listeners[event] = [];
      this._listeners[event].push(fn);
      return this;
    }

    off(event, fn) {
      if (!this._listeners[event]) return this;
      if (!fn) {
        delete this._listeners[event];
        return this;
      }
      this._listeners[event] = this._listeners[event].filter(function (f) { return f !== fn; });
      return this;
    }

    once(event, fn) {
      var self = this;
      var wrapper = function () {
        self.off(event, wrapper);
        fn.apply(self, arguments);
      };
      return this.on(event, wrapper);
    }

    // ---------------------------------------------------------------------------
    // Properties
    // ---------------------------------------------------------------------------

    get isEmbedded() {
      return this._wrapperNonce !== null;
    }

    // ---------------------------------------------------------------------------
    // Wrapper convenience methods
    // ---------------------------------------------------------------------------

    serverInfo() { return this.cmd('serverInfo'); }
    siteInfo() { return this.cmd('siteInfo'); }

    /**
     * Read this xite's wrapper-side storage (per xite and identity).
     * Data written by EpixFrame 1.0.x was stored wrapped in a one-element
     * array; that shape is unwrapped here so it keeps reading back as written.
     */
    getLocalStorage() {
      return this.cmd('wrapperGetLocalStorage').then(function (data) {
        return Array.isArray(data) && data.length === 1 ? data[0] : data;
      });
    }

    /** Write this xite's wrapper-side storage. `data` is stored as given. */
    setLocalStorage(data) { return this.cmd('wrapperSetLocalStorage', data); }

    getState() { return this.cmd('wrapperGetState'); }

    // The wrapper never answers the following commands, so they are posted
    // without registering a callback and return an already resolved Promise
    // (resolved once the message is posted, not when the wrapper acts on it).

    pushState(state) { return this._post('wrapperPushState', [state, null]); }
    replaceState(state) { return this._post('wrapperReplaceState', [state, null]); }

    setViewport(viewport) { return this._post('wrapperSetViewport', viewport); }
    setTitle(title) { return this._post('wrapperSetTitle', title); }

    notify(type, message, timeout) {
      var params = [type, message];
      if (timeout != null) params.push(timeout);
      return this._post('wrapperNotification', params);
    }

    /**
     * Show a confirmation dialog. Resolves `true` when the user clicks the
     * button (the wrapper answers 1). The wrapper sends nothing when the
     * dialog is dismissed with its close button, so the Promise then stays
     * pending.
     */
    confirm(message) {
      return this.cmd('wrapperConfirm', [message]).then(function (res) {
        return res === 1 || res === true;
      });
    }

    /**
     * Show a prompt dialog: `type` is the input type (default 'text'),
     * `caption` the button label (default 'OK'), `placeholder` the input
     * placeholder. Resolves with the entered text.
     */
    prompt(message, type, caption, placeholder) {
      return this.cmd('wrapperPrompt', [message, type || 'text', caption || '', placeholder || '']);
    }

    openWindow(url) { return this._post('wrapperOpenWindow', [url]); }
    innerLoaded() { return this._post('wrapperInnerLoaded'); }

    /**
     * Ask the user to grant this xite a permission (e.g. 'ADMIN',
     * 'Merger:EpixPost'). Resolves with the node's answer once the user
     * grants it. If the xite already holds the permission the wrapper sends
     * no answer, so check siteInfo().settings.permissions first.
     */
    requestPermission(permission) { return this.cmd('wrapperPermissionAdd', permission); }

    // ---------------------------------------------------------------------------
    // File operations
    // ---------------------------------------------------------------------------

    fileGet(path, opts) {
      var params = { inner_path: path };
      if (opts) {
        for (var k in opts) {
          if (opts.hasOwnProperty(k)) params[k] = opts[k];
        }
      }
      return this.cmd('fileGet', params);
    }

    fileWrite(path, content) { return this.cmd('fileWrite', [path, content]); }
    fileDelete(path) { return this.cmd('fileDelete', path); }
    fileList(path) { return this.cmd('fileList', path); }
    fileRules(path) { return this.cmd('fileRules', path); }
    fileNeed(path, opts) {
      var params = { inner_path: path };
      if (opts) {
        for (var k in opts) {
          if (opts.hasOwnProperty(k)) params[k] = opts[k];
        }
      }
      return this.cmd('fileNeed', params);
    }

    /**
     * List a directory's entries. With `opts.stats` the node returns
     * `[{name, is_dir, size}]`, otherwise just the names.
     */
    dirList(path, opts) {
      var params = { inner_path: path || '' };
      if (opts) {
        for (var k in opts) {
          if (opts.hasOwnProperty(k)) params[k] = opts[k];
        }
      }
      return this.cmd('dirList', params);
    }

    // ---------------------------------------------------------------------------
    // Database
    // ---------------------------------------------------------------------------

    dbQuery(query, params) {
      var args = [query];
      if (params != null) args.push(params);
      return this.cmd('dbQuery', args);
    }

    // ---------------------------------------------------------------------------
    // Site management
    // ---------------------------------------------------------------------------

    siteSign(privatekey, innerPath, opts) {
      var params = {};
      if (privatekey != null) params.privatekey = privatekey;
      if (innerPath != null) params.inner_path = innerPath;
      if (opts) {
        for (var k in opts) {
          if (opts.hasOwnProperty(k)) params[k] = opts[k];
        }
      }
      return this.cmd('siteSign', params);
    }

    sitePublish(privatekey, innerPath, opts) {
      var params = {};
      if (privatekey != null) params.privatekey = privatekey;
      if (innerPath != null) params.inner_path = innerPath;
      if (opts) {
        for (var k in opts) {
          if (opts.hasOwnProperty(k)) params[k] = opts[k];
        }
      }
      return this.cmd('sitePublish', params);
    }

    // ---------------------------------------------------------------------------
    // Identity (xID)
    // ---------------------------------------------------------------------------

    certSelect() { return this.cmd('certXid'); }
    xidResolve(address) { return this.cmd('xidResolve', { address: address }); }
    xidResolveName(name) { return this.cmd('xidResolveName', { name: name }); }
    xidResolveBatch(addresses) { return this.cmd('xidResolveBatch', { addresses: addresses }); }
    xidResolveIdentity(address) { return this.cmd('xidResolveIdentity', { address: address }); }

    /**
     * @deprecated The EpixNet node has no xidResolveSite command. This always
     * rejects. For the current xite's verified domain read
     * `siteInfo().canonical_domain`; to resolve a name use `xidResolveName`.
     */
    xidResolveSite(site) {
      var message = 'xidResolveSite is not implemented by the EpixNet node: use siteInfo().canonical_domain ' +
        'for the current xite, or xidResolveName(name)';
      if (typeof console !== 'undefined' && console.warn) console.warn('[EpixFrame] ' + message, site);
      // An Error, with the message also on `.error` like a node error reply.
      var error = new Error(message);
      error.error = message;
      return Promise.reject(error);
    }

    // ---------------------------------------------------------------------------
    // Encryption / Signing
    // ---------------------------------------------------------------------------

    encrypt(text, publickey) { return this.cmd('eciesEncrypt', [text, publickey]); }
    decrypt(text) { return this.cmd('eciesDecrypt', [text]); }
    sign(text) { return this.cmd('ecdsaSign', [text]); }
    verify(text, address, signature) { return this.cmd('ecdsaVerify', [text, address, signature]); }
    getPublicKey(index) { return this.cmd('userPublickey', [index || 0]); }
    pubToAddr(pubkey) { return this.cmd('eccPubToAddr', [pubkey]); }

    // ---------------------------------------------------------------------------
    // Feed / Newsfeed
    // ---------------------------------------------------------------------------

    feedFollow(feeds) { return this.cmd('feedFollow', [feeds]); }
    feedList() { return this.cmd('feedListFollow'); }
    /** Requires the ADMIN permission (the node refuses it otherwise). */
    feedQuery(params) { return this.cmd('feedQuery', params); }
    /** Requires the ADMIN permission (the node refuses it otherwise). */
    feedSearch(query) { return this.cmd('feedSearch', [query]); }

    // ---------------------------------------------------------------------------
    // Content filtering / Mute
    // ---------------------------------------------------------------------------

    muteAdd(authAddress, certUserId, reason) { return this.cmd('muteAdd', [authAddress, certUserId, reason]); }
    muteRemove(authAddress) { return this.cmd('muteRemove', [authAddress]); }
    /** Requires the ADMIN permission (the node refuses it otherwise). */
    muteList() { return this.cmd('muteList'); }

    // ---------------------------------------------------------------------------
    // Optional files
    // ---------------------------------------------------------------------------

    optionalFilePin(path) { return this.cmd('optionalFilePin', [path]); }
    optionalFileUnpin(path) { return this.cmd('optionalFileUnpin', [path]); }
    optionalFileDelete(path) { return this.cmd('optionalFileDelete', path); }
    optionalFileInfo(path) { return this.cmd('optionalFileInfo', path); }

    /**
     * List optional files. `filterInnerPath` is a SQL LIKE pattern on the
     * inner path ('%' matches anything, e.g. 'data/videos/%'); pass null to
     * list all. `opts` are the node's named options: `address` (another
     * xite, needs permission for it), `filter` (default 'downloaded'; a
     * comma list such as 'downloaded,bigfile'), `orderby` (default
     * 'time_downloaded DESC') and `limit`. An options object may also be
     * passed as the only argument.
     */
    optionalFileList(filterInnerPath, opts) {
      if (filterInnerPath && typeof filterInnerPath === 'object') {
        opts = filterInnerPath;
        filterInnerPath = null;
      }
      var params = {};
      if (filterInnerPath != null && filterInnerPath !== '') params.filter_inner_path = filterInnerPath;
      if (opts) {
        for (var k in opts) {
          if (opts.hasOwnProperty(k)) params[k] = opts[k];
        }
      }
      return this.cmd('optionalFileList', params);
    }
    optionalHelp(directory, title, address) { return this.cmd('optionalHelp', [directory, title, address]); }
    optionalHelpRemove(directory, address) { return this.cmd('optionalHelpRemove', [directory, address]); }

    // ---------------------------------------------------------------------------
    // Merger sites
    // ---------------------------------------------------------------------------

    mergerSiteAdd(addresses) { return this.cmd('mergerSiteAdd', addresses); }
    mergerSiteDelete(address) { return this.cmd('mergerSiteDelete', address); }
    mergerSiteList(querySiteInfo) { return this.cmd('mergerSiteList', querySiteInfo); }

    // ---------------------------------------------------------------------------
    // VRF beacon
    // ---------------------------------------------------------------------------

    vrfGetBeacon(height) { return this.cmd('vrfGetBeacon', [height]); }
    vrfLatestBeacon() { return this.cmd('vrfLatestBeacon'); }
    /**
     * Derive `count` deterministic 32-byte hex values from a beacon (the hex
     * `beacon` string of a VrfBeacon) and a seed. Resolves with a plain array
     * of hex strings: value[i] = sha256(beacon + seed + i).
     */
    vrfDeriveRandom(beacon, seed, count) { return this.cmd('vrfDeriveRandom', [beacon, seed, count]); }
    vrfMultiBlockBeacon(endHeight, blocks) { return this.cmd('vrfMultiBlockBeacon', [endHeight, blocks]); }
    vrfInvalidateCache() { return this.cmd('vrfInvalidateCache'); }

    // ---------------------------------------------------------------------------
    // Chain RPC URLs (fetched from serverInfo, cached)
    // ---------------------------------------------------------------------------

    async chainRpcUrl() {
      if (!this._serverInfoCache) this._serverInfoCache = await this.serverInfo();
      return this._serverInfoCache.chain_rpc_url || null;
    }

    async chainEvmRpcUrl() {
      if (!this._serverInfoCache) this._serverInfoCache = await this.serverInfo();
      return this._serverInfoCache.chain_evm_rpc_url || null;
    }

    async chainBlockExplorerUrl() {
      if (!this._serverInfoCache) this._serverInfoCache = await this.serverInfo();
      return this._serverInfoCache.chain_block_explorer_url || null;
    }

    // ---------------------------------------------------------------------------
    // Ajax monkey-patching
    // ---------------------------------------------------------------------------

    /**
     * Patch fetch and XMLHttpRequest so requests to this node's own host carry
     * the xite's ajax_key (required to read the xite's files from the
     * sandboxed frame). Requests to any other host are left untouched, so the
     * key never leaks to RPC endpoints or other third parties. Same-host
     * requests made before the wrapper has handed over the key wait for it
     * (fetch is delayed; an async XHR's open/setRequestHeader/send are queued).
     * Resolves once the key is known. Calling it again returns the same
     * Promise. Outside the wrapper (top-level window) nothing is patched.
     */
    monkeyPatchAjax() {
      if (this._ajaxKeyPromise != null) return this._ajaxKeyPromise;
      var self = this;

      if (typeof window === 'undefined' || window.parent === window) {
        this._ajaxKeyPromise = Promise.resolve();
        return this._ajaxKeyPromise;
      }

      // Resolves with the key, or null when it cannot be had (the request
      // then goes out unkeyed, exactly as without the patch).
      var keyReady = this.cmd('wrapperGetAjaxKey').then(function (key) {
        self._ajaxKey = key;
        return key;
      }, function (err) {
        self.log('wrapperGetAjaxKey failed', err);
        return null;
      });
      this._ajaxKeyPromise = keyReady.then(function () {});

      if (window.__epixFrameAjaxPatched) return this._ajaxKeyPromise;
      window.__epixFrameAjaxPatched = true;

      // The URL to key, or null when `url` is not on this node's host or
      // already carries a key.
      function keyable(url) {
        var loc = window.location;
        var u;
        try {
          u = new URL(String(url), loc.href);
        } catch (e) {
          return null;
        }
        if (u.protocol !== loc.protocol || u.host !== loc.host) return null;
        if (u.searchParams.has('ajax_key')) return null;
        return u;
      }

      if (typeof XMLHttpRequest !== 'undefined') {
        var proto = XMLHttpRequest.prototype;
        var realOpen = proto.open;
        var realSend = proto.send;
        var realSetRequestHeader = proto.setRequestHeader;
        var realAbort = proto.abort;
        if (!proto._realOpen) proto._realOpen = realOpen;

        proto.open = function (method, url) {
          var args = Array.prototype.slice.call(arguments);
          this._epixDeferred = null;
          var u = keyable(url);
          if (u) {
            if (self._ajaxKey != null) {
              args[1] = withKey(u, self._ajaxKey);
            } else if (args.length < 3 || args[2] !== false) {
              // Async request before the key arrived: replay it once it does.
              this._epixDeferred = { open: args, url: u, headers: [] };
              return;
            } else {
              self.log('Synchronous XHR before the ajax key arrived, sent without it:', url);
            }
          }
          return realOpen.apply(this, args);
        };

        proto.setRequestHeader = function () {
          if (this._epixDeferred) {
            this._epixDeferred.headers.push(Array.prototype.slice.call(arguments));
            return;
          }
          return realSetRequestHeader.apply(this, arguments);
        };

        proto.send = function () {
          var deferred = this._epixDeferred;
          if (!deferred) return realSend.apply(this, arguments);
          var sendArgs = Array.prototype.slice.call(arguments);
          // Arrow function: `this` stays the XHR being replayed.
          keyReady.then((key) => {
            if (this._epixDeferred !== deferred) return; // aborted or reopened
            this._epixDeferred = null;
            var openArgs = deferred.open.slice();
            if (key != null) openArgs[1] = withKey(deferred.url, key);
            realOpen.apply(this, openArgs);
            for (var header of deferred.headers) {
              realSetRequestHeader.apply(this, header);
            }
            realSend.apply(this, sendArgs);
          }).catch(function (err) {
            // send() already returned, so the caller cannot see this throw.
            self.log('Deferred XHR could not be sent:', err);
          });
        };

        proto.abort = function () {
          if (this._epixDeferred) {
            this._epixDeferred = null;
            return;
          }
          return realAbort.apply(this, arguments);
        };
      }

      if (window.fetch) {
        var realFetch = window.fetch;
        if (!window._realFetch) window._realFetch = realFetch;
        window.fetch = function (input) {
          var args = Array.prototype.slice.call(arguments);
          var isRequest = typeof Request !== 'undefined' && input instanceof Request;
          var u = keyable(isRequest ? input.url : input);
          if (!u) return realFetch.apply(window, args);
          return keyReady.then(function (key) {
            if (key != null) {
              var keyed = withKey(u, key);
              args[0] = isRequest ? new Request(keyed, input) : keyed;
            }
            return realFetch.apply(window, args);
          });
        };
      }

      return this._ajaxKeyPromise;
    }

    // ---------------------------------------------------------------------------
    // Private methods
    // ---------------------------------------------------------------------------

    _extractNonce() {
      if (typeof document === 'undefined') return null;
      var match = document.location.href.match(/wrapper_nonce=([A-Za-z0-9]+)/);
      return match ? match[1] : null;
    }

    _connect() {
      this._target = window.parent;
      this.target = this._target; // CoffeeScript compat

      var self = this;
      window.addEventListener('message', function (e) { self._onMessage(e); }, false);

      this._sendRaw({ cmd: 'innerReady', params: {} });
      this._connected = true;

      // Scroll state: save on unload
      window.addEventListener('beforeunload', function () {
        self.history_state.scrollTop = window.pageYOffset || document.documentElement.scrollTop || 0;
        void self._post('wrapperReplaceState', [self.history_state, null]);
      });

      // Scroll state: restore on connect
      this.cmd('wrapperGetState', {}, function (state) {
        if (state) { self._historyState = state; self.history_state = state; }
        if ((window.pageYOffset || 0) === 0 && state && state.scrollTop) {
          window.scroll(window.pageXOffset || 0, state.scrollTop);
        }
      });
    }

    _onMessage(e) {
      var data = e.data;
      if (!data || typeof data !== 'object' || !data.cmd) return;

      var cmd = data.cmd;

      if (cmd === 'response') {
        var entry = this._waitingCb[data.to];
        if (entry) {
          delete this._waitingCb[data.to];
          if (entry.resolve) {
            // Promise mode
            if (data.result && data.result.error) {
              entry.reject(data.result);
            } else {
              entry.resolve(data.result);
            }
          } else if (entry.cb) {
            // Callback mode  - pass result as-is (no rejection)
            entry.cb(data.result);
          }
        }
      } else if (cmd === 'wrapperReady') {
        this._sendRaw({ cmd: 'innerReady', params: {} });
      } else if (cmd === 'ping') {
        this.response(data.id, 'pong');
      } else if (cmd === 'wrapperOpenedWebsocket') {
        this.onOpenWebsocket();
        this._emit('openWebsocket');
      } else if (cmd === 'wrapperClosedWebsocket') {
        this.onCloseWebsocket();
        this._emit('closeWebsocket');
      } else {
        this.onRequest(cmd, data);
        this._emit('request', cmd, data);
      }
    }

    _send(message, cb, resolve, reject) {
      message.wrapper_nonce = this._wrapperNonce;
      message.id = this._nextId;
      this.next_message_id = this._nextId; // CoffeeScript compat
      this._nextId++;

      if (this._target) {
        this._target.postMessage(message, '*');
      }

      if (cb) {
        this._waitingCb[message.id] = { cb: cb };
      } else if (resolve) {
        this._waitingCb[message.id] = { resolve: resolve, reject: reject };
      }
    }

    _sendRaw(message) {
      message.wrapper_nonce = this._wrapperNonce;
      message.id = this._nextId++;
      if (this._target) {
        this._target.postMessage(message, '*');
      }
    }

    // Fire-and-forget: post a command the wrapper never answers, without
    // leaving an entry in the pending-callback map.
    _post(cmd, params) {
      this._sendRaw({ cmd: cmd, params: params == null ? {} : params });
      return Promise.resolve();
    }

    _emit(event) {
      var listeners = this._listeners[event];
      if (!listeners) return;
      var args = [];
      for (var i = 1; i < arguments.length; i++) args.push(arguments[i]);
      for (var j = 0; j < listeners.length; j++) {
        listeners[j].apply(this, args);
      }
    }
  }

  // Shared instance, created lazily on first use so that loading the library
  // never starts a frame that would compete with a subclass instance.
  var _singleton = null;

  function getEpixFrame() {
    if (!_singleton) _singleton = new EpixFrame();
    return _singleton;
  }

  // `epixFrame` behaves as the shared instance (`epixFrame.siteInfo()`, the
  // same object as the UMD window.epixFrame) and, for 1.0.x code, can still be
  // called: `epixFrame()` returns that instance. The instance is created on the
  // first property access or call, not at import.
  var epixFrame = new Proxy(() => {}, {
    apply: function () {
      return getEpixFrame();
    },
    get: function (target, prop) {
      var instance = getEpixFrame();
      var value = instance[prop];
      return typeof value === 'function' && prop !== 'constructor' ? value.bind(instance) : value;
    },
    set: function (target, prop, value) {
      getEpixFrame()[prop] = value;
      return true;
    },
    has: function (target, prop) {
      return prop in getEpixFrame();
    },
    getPrototypeOf: function () {
      return Object.getPrototypeOf(getEpixFrame());
    }
  });

  exports.EpixFrame = EpixFrame;
  exports.epixFrame = epixFrame;

}));

if (typeof window !== 'undefined') {
  window.EpixFrame = EpixFrameModule.EpixFrame;
  // The module's lazy shared instance (the one the ESM export proxies), so
  // window.epixFrame and EpixFrameModule.epixFrame are the same frame.
  Object.defineProperty(window, 'epixFrame', {
    get: function() {
      return EpixFrameModule.epixFrame();
    },
    configurable: true
  });
}

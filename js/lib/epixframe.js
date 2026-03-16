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
   *   ES module:   import { EpixFrame, epixFrame } from '@epixzone/epixframe'
   *   CoffeeScript: class MyApp extends EpixFrame
   *
   * @license MIT
   * @version 1.0.0
   */

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
    // ---------------------------------------------------------------------------

    init() {
      return this;
    }

    onOpenWebsocket() {
      this.log('Websocket open');
      this._emit('openWebsocket');
    }

    onCloseWebsocket() {
      this.log('Websocket close');
      this._emit('closeWebsocket');
    }

    onRequest(cmd, message) {
      this.log('Unknown request', cmd, message);
      this._emit('request', cmd, message);
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

    getLocalStorage() { return this.cmd('wrapperGetLocalStorage'); }
    setLocalStorage(data) { return this.cmd('wrapperSetLocalStorage', [data]); }

    getState() { return this.cmd('wrapperGetState'); }
    pushState(state) { return this.cmd('wrapperPushState', [state, null]); }
    replaceState(state) { return this.cmd('wrapperReplaceState', [state, null]); }

    setViewport(viewport) { return this.cmd('wrapperSetViewport', viewport); }
    setTitle(title) { return this.cmd('wrapperSetTitle', title); }

    notify(type, message, timeout) {
      var params = [type, message];
      if (timeout != null) params.push(timeout);
      return this.cmd('wrapperNotification', params);
    }

    confirm(message) { return this.cmd('wrapperConfirm', [message]); }
    prompt(message, type, placeholder) { return this.cmd('wrapperPrompt', [message, type || 'text', placeholder || '']); }

    openWindow(url) { return this.cmd('wrapperOpenWindow', [url]); }
    innerLoaded() { return this.cmd('wrapperInnerLoaded'); }
    requestPermission(permission) { return this.cmd('wrapperPermissionAdd', [permission]); }

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
    dirList(path, opts) { return this.cmd('dirList', [path, opts]); }

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
    xidResolveSite(site) { return this.cmd('xidResolveSite', { site: site }); }

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
    feedQuery(params) { return this.cmd('feedQuery', params); }
    feedSearch(query) { return this.cmd('feedSearch', [query]); }

    // ---------------------------------------------------------------------------
    // Content filtering / Mute
    // ---------------------------------------------------------------------------

    muteAdd(authAddress, certUserId, reason) { return this.cmd('muteAdd', [authAddress, certUserId, reason]); }
    muteRemove(authAddress) { return this.cmd('muteRemove', [authAddress]); }
    muteList() { return this.cmd('muteList'); }

    // ---------------------------------------------------------------------------
    // Optional files
    // ---------------------------------------------------------------------------

    optionalFilePin(path) { return this.cmd('optionalFilePin', [path]); }
    optionalFileUnpin(path) { return this.cmd('optionalFileUnpin', [path]); }
    optionalFileDelete(path) { return this.cmd('optionalFileDelete', path); }
    optionalFileInfo(path) { return this.cmd('optionalFileInfo', path); }
    optionalFileList(path) { return this.cmd('optionalFileList', [path]); }
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
    vrfDeriveRandom(height, seed, count) { return this.cmd('vrfDeriveRandom', [height, seed, count]); }
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

    async monkeyPatchAjax() {
      var self = this;

      if (typeof XMLHttpRequest !== 'undefined') {
        XMLHttpRequest.prototype._realOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url, async) {
          url += (url.indexOf('?') === -1 ? '?' : '&') + 'ajax_key=' + self._ajaxKey;
          return this._realOpen(method, url, async);
        };
      }

      if (typeof window !== 'undefined' && window.fetch) {
        window._realFetch = window.fetch;
        window.fetch = function (url) {
          if (typeof url === 'string') {
            url += (url.indexOf('?') === -1 ? '?' : '&') + 'ajax_key=' + self._ajaxKey;
          }
          return window._realFetch.apply(window, arguments);
        };
      }

      this._ajaxKey = await this.cmd('wrapperGetAjaxKey');
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
        self.cmd('wrapperReplaceState', [self.history_state, null]);
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
      } else if (cmd === 'wrapperClosedWebsocket') {
        this.onCloseWebsocket();
      } else {
        this.onRequest(cmd, data);
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

  // Singleton instance (lazy  - only created in UMD footer or when explicitly called)
  var _singleton = null;

  function getEpixFrame() {
    if (!_singleton) _singleton = new EpixFrame();
    return _singleton;
  }

  exports.EpixFrame = EpixFrame;
  exports.epixFrame = getEpixFrame;

}));

if (typeof window !== 'undefined') {
  window.EpixFrame = EpixFrameModule.EpixFrame;
  var _epixFrameSingleton = null;
  Object.defineProperty(window, 'epixFrame', {
    get: function() {
      if (!_epixFrameSingleton) _epixFrameSingleton = new EpixFrameModule.EpixFrame();
      return _epixFrameSingleton;
    },
    configurable: true
  });
}

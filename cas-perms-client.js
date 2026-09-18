/**
 * cas-perms-client.js
 * -----------------------------------------------------------------------
 * Source for the `CAS` global that user code (offline apps, background
 * workers, plugins) calls: CAS.fs.modify(), CAS.notify(), CAS.import().
 * Exported as a template string because it has to run in three different
 * contexts that can't share a module graph: a dedicated Worker (app
 * background workers, plugin main.js), a plain window (WebContainer-
 * served offline apps), and — for reference/offline-import purposes — as
 * the literal file written to casf/CAS/apis/cas_perms.js.
 *
 * All three talk the same tiny RPC protocol to whichever host is on the
 * other end (bw-manager.js for workers, webcontainer-runtime.js's window
 * listener for served apps): {type:"cas:call", callId, method, args} out,
 * {type:"cas:result", callId, ok, result|error} back.
 * -----------------------------------------------------------------------
 */

export const CAS_PERMS_CLIENT_SRC = `
(function () {
  var isWorkerContext = typeof window === "undefined";
  var pending = new Map();
  var nextCallId = 1;

  function send(msg) {
    if (isWorkerContext) self.postMessage(msg);
    else if (window.opener) window.opener.postMessage(msg, "*");
    else console.warn("[CAS] no host to talk to — CAS.* calls will hang.");
  }

  function call(method, args) {
    var callId = nextCallId++;
    return new Promise(function (resolve, reject) {
      pending.set(callId, { resolve: resolve, reject: reject });
      send({ type: "cas:call", callId: callId, method: method, args: args });
    });
  }

  function onHostMessage(event) {
    var msg = event.data;
    if (!msg || msg.type !== "cas:result") return;
    var entry = pending.get(msg.callId);
    if (!entry) return;
    pending.delete(msg.callId);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error));
  }
  (isWorkerContext ? self : window).addEventListener("message", onHostMessage);

  function makePluginProxy(pluginName) {
    return new Proxy(
      {},
      {
        get: function (_target, methodName) {
          if (typeof methodName !== "string") return undefined;
          return function () {
            var args = Array.prototype.slice.call(arguments);
            return call("plugin.call", [pluginName, methodName, args]);
          };
        },
      }
    );
  }

  var CAS = {
    fs: {
      modify: function (path, content) {
        return call("fs.modify", [path, content]);
      },
    },
    notify: function (title, desc) {
      return call("notify", [title, desc]);
    },
    import: function (pluginName) {
      return makePluginProxy(pluginName);
    },
  };

  (isWorkerContext ? self : window).CAS = CAS;
})();
`;

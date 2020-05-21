/* eslint-env node */
const shimmer = require("shimmer"),
  tracker = require("../async_tracker"),
  schema = require("../schema"),
  api = require("../api"),
  traceUtil = require("./trace-util"),
  path = require("path"),
  pkg = require(path.join(__dirname, "..", "..", "package.json")),
  debug = require("debug")(`${pkg.name}:hapi`);

function isPromise(p) {
  return p && typeof p.then !== "undefined";
}
const instrumentHapi = function(HapiNamespace, opts = {}) {
  let userContext, traceIdSource, parentIdSource;
  if (opts.userContext) {
    if (Array.isArray(opts.userContext) || typeof opts.userContext === "function") {
      userContext = opts.userContext;
    } else {
      debug(
        "userContext option must either be an array of field names or a function returning an object"
      );
    }
  }
  if (opts.traceIdSource) {
    if (typeof opts.traceIdSource === "string" || typeof opts.traceIdSource === "function") {
      traceIdSource = opts.traceIdSource;
    } else {
      debug(
        "traceIdSource option must either be an string (the http header name) or a function returning the string request id"
      );
    }
  }
  if (opts.parentIdSource) {
    if (typeof opts.parentIdSource === "string" || typeof opts.traceIdSource === "function") {
      parentIdSource = opts.parentIdSource;
    } else {
      debug(
        "parentIdSource option must either be an string (the http header name) or a function returning the string request id"
      );
    }
  }

  const trackedByRequest = opts.requestMap || new Map();
  const finishersByRequest = opts.finishersMap || new Map();

  const wrappedServer = function(...args) {
    const server = new HapiNamespace.Server(...args);
    server.app.hny = { tracker, api };

    // Useful for context propagation in plugins that want to add
    // tracked behavior outside the standard request lifecycle
    const withTraceContextFromRequestId = function(requestId, fn) {
      const tracked = trackedByRequest.get(requestId);
      tracker.setTracked(tracked);
      return api.bindFunctionToTrace(fn);
    };

    // Hapi ecosystem provides an in-house websocket library, `@hapi/nes`
    // It suffers from the same event-bus-driven (-> context propagation dropping)
    // problems as Hapi, so expose similar functionality to start/stop traces
    // for socket connections.
    const initializeSocketTrace = function(socket, traceContext) {
      const traceMetadata = {
        [schema.EVENT_TYPE]: "hapi/nes",
        [schema.PACKAGE_VERSION]: opts.packageVersion,
        [schema.TRACE_SPAN_NAME]: "socket",
        [schema.TRACE_ID_SOURCE]: traceContext.source,
      };
      const trace = api.startTrace(
        traceMetadata,
        traceContext.traceId,
        traceContext.parentSpanId,
        traceContext.dataset
      );
      if (traceContext.customContext) {
        api.addContext(traceContext.customContext);
      }

      const boundFinisher = api.bindFunctionToTrace(() => {
        api.finishTrace(trace);
      });

      finishersByRequest.set(socket.id, boundFinisher);
      trackedByRequest.set(socket.id, tracker.getTracked());
      return trace;
    };

    const finishSocketTrace = function(socket) {
      const finisher = finishersByRequest.get(socket.id);
      if (finisher) {
        finisher();
      }
    };

    const requestIdTrackingBeeline = {
      initializeSocketTrace,
      finishSocketTrace,
      withTraceContextFromRequestId,
    };

    Object.keys(api).forEach(k => {
      if (k === "configure") {
        // skip this one, though
        return;
      }
      requestIdTrackingBeeline[k] = api[k];
    });
    server.decorate("toolkit", "beeline", requestIdTrackingBeeline);
    server.decorate("server", "beeline", requestIdTrackingBeeline);

    // Ensure we have a base trace to work with.
    server.ext("onRequest", (request, h) => {
      let traceContext = traceUtil.getTraceContext(traceIdSource, request);
      let parentTraceId = traceUtil.getParentSourceId(parentIdSource, request);
      if (parentTraceId) {
        traceContext.parentSpanId = parentTraceId;
      }
      const traceMetadata = {
        [schema.EVENT_TYPE]: "hapi",
        [schema.PACKAGE_VERSION]: opts.packageVersion,
        [schema.TRACE_SPAN_NAME]: "request",
        [schema.TRACE_ID_SOURCE]: traceContext.source,
        "request.method": request.method,
        "request.host": request.url && request.url.host,
        "request.original_url": request.url && request.url.href,
        "request.path": request.path,
      };
      for (const [infoName, infoValue] of Object.entries(request.info)) {
        traceMetadata[`request.info.${infoName}`] = infoValue;
      }
      for (const [headerName, headerValue] of Object.entries(request.headers)) {
        traceMetadata[`request.headers.${headerName}`] = headerValue;
      }
      for (const [serverInfoName, serverInfoValue] of Object.entries(request.server.info)) {
        traceMetadata[`server.info.${serverInfoName}`] = serverInfoValue;
      }

      const trace = api.startTrace(
        traceMetadata,
        traceContext.traceId,
        traceContext.parentSpanId,
        traceContext.dataset
      );

      if (!trace) {
        // sampler has decided that we shouldn't trace this request
        return h.continue;
      }

      // I think I like using `request.app` better than `h.beeline` -- to consider later.
      request.app.hny = { trace };

      if (traceContext.customContext) {
        api.addContext(traceContext.customContext);
      }

      // Adding this to ease sampling of all events related to a specific path; all children
      // of this root span can be sampled out by querying for `app.request.path`
      api.addTraceContext({ "request.path": request.path });

      const boundFinisher = api.bindFunctionToTrace(request => {
        let userEventContext = traceUtil.getUserContext(userContext, request);
        if (userEventContext) {
          api.addContext(userEventContext);
        }

        api.addContext({
          "response.status_code": String(request.response.statusCode),
        });

        api.finishTrace(trace);
      });

      finishersByRequest.set(request.info.id, boundFinisher);
      trackedByRequest.set(request.info.id, tracker.getTracked());

      return h.continue;
    });

    // Once the request life cycle is at the point of parsed query / params, add them
    // as indepdentent context items.
    server.ext("onPreHandler", (request, h) => {
      const tracked = trackedByRequest.get(request.info.id);
      tracker.setTracked(tracked);
      if (!api.traceActive()) {
        return h.continue;
      }
      const context = {};
      if (request.query) {
        for (const [queryName, queryValue] of Object.entries(request.query)) {
          context[`request.query.${queryName}`] = queryValue;
        }
      }
      if (request.params) {
        for (const [paramName, paramValue] of Object.entries(request.params)) {
          context[`request.params.${paramName}`] = paramValue;
        }
      }
      api.addContext(context);
      return h.continue;
    });

    // The server emits an event when a response is being delivered; hook in,
    // force the context, and end the trace.
    server.events.on("response", request => {
      const finisher = finishersByRequest.get(request.info.id);
      if (finisher) {
        finisher(request);
        finishersByRequest.delete(request.info.id);
        trackedByRequest.delete(request.info.id);
      }
    });

    // Hapi ensures that a `response` event will always be fired, even if any of the
    // handling logic threw. This listener listens for all errors and adds any extra
    // context that they contain. It **does not** close the span though, which is left
    // to the globally bound `response` event handler (above).
    server.events.on({ name: "request", channels: "error" }, (request, event, _tags) => {
      const { error } = event;
      const tracked = trackedByRequest.get(request.info.id);
      tracker.setTracked(tracked);
      if (error) {
        api.addContext({ "error.message": error.message, "error.stack": error.stack });
      } else {
        api.addContext({ error: "unknown" });
      }
    });

    function instrumentLifecyclePoint(eventName, method) {
      const serverLifecycleExtensions = ["onPreStart", "onPostStart", "onPreStop", "onPostStop"];
      if (method.__wrapped || serverLifecycleExtensions.includes(eventName)) {
        return method;
      }
      const wrappedImplementation = function(request, h) {
        const tracked = trackedByRequest.get(request.info.id);
        tracker.setTracked(tracked);
        if (!api.traceActive()) {
          return h.continue;
        }
        const span = api.startSpan({
          name: eventName,
          [schema.EVENT_TYPE]: "hapi",
          [schema.PACKAGE_VERSION]: opts.packageVersion,
        });

        let rv;
        try {
          rv = method.apply(this, [request, h]);
        } catch (error) {
          // An error came out of the original handler; add it to the context
          api.addContext({ "error.message": error.message, "error.stack": error.stack });
          // Emit a zero-time event for visual convenience
          api.finishSpan(api.startSpan({ name: "error" }));
          // Rethrow so the Hapi's error handling framework gets what it needs
          throw error;
        } finally {
          // Ensure we close the span for the handler.
          tracker.setTracked(tracked);
          if (!isPromise(rv)) {
            api.finishSpan(span);
          }
        }

        if (!isPromise(rv)) {
          return rv;
        }

        return new Promise((resolve, reject) => {
          rv.then(v => {
            tracker.setTracked(tracked);
            resolve(v);
          })
            .catch(error => {
              api.addContext({ "error.message": error.message, "error.stack": error.stack });
              api.finishSpan(api.startSpan({ name: "error" }));
              reject(error);
            })
            .finally(() => {
              tracker.setTracked(tracked);
              api.finishSpan(span);
            });
        });
      };
      wrappedImplementation.__wrapped = true;
      return wrappedImplementation;
    }
    // Hapi manages the request lifecycle through an internal eventbus; the
    // standard Honeycomb `async_tracker` loses the context. Here we wrap the
    // central router to ensure all handlers and their decomposed extension points
    // pull in the right trace/span context.
    function instrumentRoute(original) {
      return function(routeOptions) {
        // Hapi exposes six extension points:
        // [onRequest, onPreAuth, onCredentials, onPostAuth, onPreHandler, onPostHandler, onPreResponse].
        // Each can be configured on a route-by-route basis. Each handler is independently
        // triggered via the Hapi bus, so we have to wrap and force the trace context.
        // NB: we must to _also_ independently wrap the `options.pre` array because it
        // behaves slightly differently from the rest of the extension points.
        const { options } = routeOptions;
        if (options) {
          if (options.ext) {
            for (const [extensionPoint, extension] of Object.entries(routeOptions.options.ext)) {
              const { method } = extension;
              extension.method = instrumentLifecyclePoint(extensionPoint, method);
              routeOptions.options.ext[extensionPoint] = extension;
            }
          }
          if (options.pre) {
            options.pre.forEach((handlerOrList, i) => {
              const list = Array.isArray(handlerOrList) ? handlerOrList : [handlerOrList];
              list.forEach((handler, i) => {
                const method = typeof handler === "function" ? handler : handler.method;
                const wrappedPreHandler = instrumentLifecyclePoint("pre", method);
                wrappedPreHandler.__wrapped = true;
                list[i] = wrappedPreHandler;
              });
              options.pre[i] = list;
            });
          }

          // The core handler can be defined in the generic options object
          if (options.handler) {
            options.handler = instrumentLifecyclePoint("handler", options.handler);
          }
        }

        // The core handler can also be defined as top level member of the route config
        if (routeOptions.handler) {
          routeOptions.handler = instrumentLifecyclePoint("handler", routeOptions.handler);
          // What is now called "options" used to be called "config" -- backward compatible.
        } else if (routeOptions.config && routeOptions.config.handler) {
          routeOptions.config.handler = instrumentLifecyclePoint(
            "handler",
            routeOptions.config.handler
          );
        }

        return original.apply(server, [routeOptions, server]);
      };
    }
    function instrumentServerExt(original) {
      return function(options) {
        options.method.forEach((method, i) => {
          options.method[i] = instrumentLifecyclePoint(options.type, method);
        });
        return original.apply(server, [options]);
      };
    }

    // When an arbitrary plugin registers routes, Hapi shallow clones its internal server via
    // this method -- and the result doesn't have the shimmed version of `_addRoute`
    function instrumentClone(original) {
      return function(name) {
        const cloned = original.apply(server, [name]);
        cloned._addRoute = instrumentRoute(cloned._addRoute);
        cloned._ext = instrumentServerExt(cloned._ext);
        return cloned;
      };
    }

    instrumentRoute.__wrapped = true;
    shimmer.wrap(server, "_ext", original => instrumentServerExt(original));
    shimmer.wrap(server, "_addRoute", original => instrumentRoute(original));
    shimmer.wrap(server, "_clone", original => instrumentClone(original));
    return server;
  };

  Object.defineProperties(wrappedServer, Object.getOwnPropertyDescriptors(HapiNamespace.Server));
  wrappedServer.__wrapped = true;
  return { Server: wrappedServer, server: wrappedServer };
};

module.exports = instrumentHapi;

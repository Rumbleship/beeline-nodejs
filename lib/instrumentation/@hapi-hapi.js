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
const instrumentHapi = function(Hapi, opts = {}) {
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

  const trackedByRequest = new Map();
  const finishersByRequest = new Map();

  const wrapper = function(...args) {
    const server = new Hapi.Server(...args);
    server.decorate("toolkit", "beeline", {
      api,
      tracker,
      trackedByRequest,
      finishersByRequest,
    });
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
        "request.host": request.url.host,
        "request.original_url": request.url.href,
        "request.path": request.path,
      };
      for (const [infoName, infoValue] of Object.entries(request.info)) {
        traceMetadata[`request.info.${infoName}`] = infoValue;
      }
      for (const [headerName, headerValue] of Object.entries(request.headers)) {
        traceMetadata[`request.headers.${headerName}`] = headerValue;
      }

      const trace = api.startTrace(
        traceMetadata,
        traceContext.traceId,
        traceContext.parentSpanId,
        traceContext.dataset
      );

      if (traceContext.customContext) {
        api.addContext(traceContext.customContext);
      }

      if (!trace) {
        // sampler has decided that we shouldn't trace this request
        return h.continue;
      }

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

      finishersByRequest.set(request, boundFinisher);
      trackedByRequest.set(request, tracker.getTracked());

      return h.continue;
    });

    server.ext("onPreHandler", (request, h) => {
      const tracked = trackedByRequest.get(request);
      tracker.setTracked(tracked);

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

    server.events.on("response", request => {
      const finisher = finishersByRequest.get(request);
      if (finisher) {
        finisher(request);
      }
    });

    function instrumentRoute(original) {
      return function(routeOptions) {
        const { handler, options } = routeOptions;

        if (options && options.ext) {
          for (const [extensionPoint, extension] of Object.entries(routeOptions.options.ext)) {
            const { method } = extension;
            const wrappedExtensionImpl = function(request, h) {
              const tracked = trackedByRequest.get(request);
              tracker.setTracked(tracked);
              const span = api.startSpan({
                name: `${extensionPoint}`,
                [schema.EVENT_TYPE]: "hapi",
                [schema.PACKAGE_VERSION]: opts.packageVersion,
              });

              let rv = method.apply(this, [request, h]);
              if (!isPromise(rv)) {
                api.finishSpan(span);
                return rv;
              }

              return new Promise((resolve, reject) => {
                rv.then(v => {
                  tracker.setTracked(tracked);
                  api.finishSpan(span);
                  resolve(v);
                }).catch(e => {
                  tracker.setTracked(tracked);
                  api.finishSpan(span);
                  reject(e);
                });
              });
            };
            wrappedExtensionImpl.__wrapped = true;
            extension.method = wrappedExtensionImpl;
            routeOptions.options.ext[extensionPoint] = extension;
          }
        }

        const wrappedHandler = function(request, h) {
          const tracked = trackedByRequest.get(request);
          tracker.setTracked(tracked);
          const span = api.startSpan({
            name: `handler`,
            [schema.EVENT_TYPE]: "hapi",
            [schema.PACKAGE_VERSION]: opts.packageVersion,
          });

          let rv = handler.apply(this, [request, h]);
          if (!isPromise(rv)) {
            api.finishSpan(span);
            return rv;
          }

          return new Promise((resolve, reject) => {
            rv.then(v => {
              tracker.setTracked(tracked);
              api.finishSpan(span);
              resolve(v);
            }).catch(e => {
              tracker.setTracked(tracked);
              api.finishSpan(span);
              reject(e);
            });
          });
        };

        routeOptions.handler = wrappedHandler;

        return original.apply(server, [routeOptions, server]);
      };
    }
    instrumentRoute.__wrapped = true;
    shimmer.wrap(server, "_addRoute", original => instrumentRoute(original));
    // for (const extensionPoint of [

    // ]){
    //   shimmer.wrap(
    //     server._core.extensions.route[extensionPoint],
    //     'add',
    //     function instrumentExtension(original) {
    //       return function(event){
    //         event.method.forEach(function (method, i) {
    //           if(!method.__wrapped){
    //             const wrappedMethod = function(request, h) {
    //               const tracked = trackedByRequest.get(request);
    //               tracker.setTracked(tracked);
    //               return new Promise((resolve, reject) => {
    //                 const value = api.startAsyncSpan({
    //                   name: event.type,
    //                   [schema.EVENT_TYPE]: 'hapi',
    //                   [schema.PACKAGE_VERSION]: opts.packageVersion
    //                 }, span => {
    //                   let rv;
    //                   try {
    //                     rv = method.apply(this, [request, h, "WRAPPED"]);
    //                   } catch(error){
    //                     api.addContext({error});
    //                     throw error;
    //                   } finally {
    //                     if(!isPromise(rv)){
    //                       api.finishSpan(span);
    //                     }
    //                   }

    //                   if(isPromise(rv)){
    //                     rv.catch(error => {
    //                       api.addContext({error});
    //                       throw error;
    //                     }).finally(() => {
    //                       api.finishSpan(span);
    //                     });
    //                   }
    //                   return rv;
    //                 });
    //                 if(isPromise(value)) {
    //                   value.then(resolve).catch(reject);
    //                 } else {
    //                   resolve(value);
    //                 }
    //               });

    //               // const value = api.startAsyncSpan({}, span => {

    //               //   new Promise((resolve, reject) => {
    //               //     const rv = method.apply(this, [request, h]);
    //               //     if(!isPromise(rv)){

    //               //     }
    //               //   });
    //               // }
    //               // return api.startAsyncSpan({
    //               //   name: event.type,
    //               //   [schema.EVENT_TYPE]: 'hapi',
    //               //   [schema.PACKAGE_VERSION]: opts.packageVersion
    //               // }, span => {
    //               //   try {
    //               //     let rv = method.apply(this, [request, h]);
    //               //     if (!isPromise(rv)) {
    //               //       api.finishSpan(span);
    //               //       return rv;
    //               //     }
    //               //     return new Promise((resolve, reject) => {
    //               //       rv.then(v => {
    //               //         tracker.setTracked(tracked);
    //               //         api.finishSpan(span);
    //               //         resolve(v);
    //               //       }).catch(e => {
    //               //         tracker.setTracked(tracked);
    //               //         api.finishSpan(span);
    //               //         reject(e);
    //               //       });
    //               //     });
    //               //   } catch(error) {
    //               //   api.addContext({error});
    //               //   } finally {
    //               //     api.finishSpan(span);
    //               //   }
    //               // });
    //             };

    //             wrappedMethod.__wrapped = true;
    //             event.method[i] = wrappedMethod;
    //           }
    //         });

    //         return original.apply(server._core.extensions.route[extensionPoint], [event, server]);
    //       };
    //     }
    //   );
    // }
    return server;
  };

  Object.defineProperties(wrapper, Object.getOwnPropertyDescriptors(Hapi));
  wrapper.__wrapped = true;
  return wrapper;
};

module.exports = instrumentHapi;

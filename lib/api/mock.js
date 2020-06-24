/* eslint-env node */
const path = require("path"),
  pkg = require(path.join(__dirname, "..", "..", "package.json")),
  tracker = require("../async_tracker"),
  schema = require("../schema"),
  Span = require("./span");

module.exports = class MockEventAPI {
  constructor(opts) {
    this.constructorArg = opts;
    this.traceContext = {};
    this.sentEvents = [];
    this.traceId = 0;
  }

  startTrace(metadataContext, traceId) {
    let id = this.traceId++;
    tracker.setTracked({ id: traceId || id, spanId: 50000, stack: [] });
    return this.startSpan(metadataContext, id);
  }
  finishTrace(ev) {
    this.finishSpan(ev);
    tracker.deleteTracked();
  }
  startSpan(metadataContext, spanId = undefined, parentId = undefined) {
    let context = tracker.getTracked();
    // copied from `libhoney.js` implementation
    if (!context) {
      // valid, since we can end up in our instrumentation outside of requests we're tracking
      return;
    }
    if (context.stack.length > 0) {
      parentId = context.stack[context.stack.length - 1].payload[schema.TRACE_SPAN_ID];
    }
    if (!parentId) {
      parentId = context.parentId;
    }
    const span = new Span(
      Object.assign({}, metadataContext, {
        [schema.TRACE_ID]: context.id,
        [schema.TRACE_SPAN_ID]: spanId || ++context.spanId,
      })
    );
    if (parentId) {
      span.addContext({ [schema.TRACE_PARENT_ID]: parentId });
    }
    context.stack.push(span);
    return span;
  }
  startAsyncSpan(metadataContext, spanFn) {
    let parentId;
    let context = tracker.getTracked();
    if (!context) {
      // valid, since we can end up in our instrumentation outside of requests we're tracking
      spanFn({});
      return;
    }
    let spanId = context.spanId + 1000;
    if (context.stack.length > 0) {
      parentId = context.stack[context.stack.length - 1].payload[schema.TRACE_SPAN_ID];
    }

    const span = new Span(
      Object.assign({}, metadataContext, {
        [schema.TRACE_ID]: context.id,
        [schema.TRACE_SPAN_ID]: ++spanId,
      })
    );
    if (parentId) {
      span.addContext({ [schema.TRACE_PARENT_ID]: parentId });
    }

    let newContext = {
      id: context.id,
      spanId,
      stack: [span],
    };

    return tracker.callWithContext(() => spanFn(span), newContext);
  }

  finishSpan(span, _rollup) {
    const payload = span.finalizePayload();

    // override this so we don't have to worry about test durations
    payload[schema.DURATION_MS] = 0;

    payload[schema.BEELINE_VERSION] = pkg.version;

    let context = tracker.getTracked();
    if (!context) {
      return;
    }
    if (context.stack.length === 0) {
      // this _really_ shouldn't happen.
      return;
    }
    // pop it off the stack
    const idx = context.stack.indexOf(span);
    if (idx === -1) {
      // again, this _really_ shouldn't happen.
      return;
    }
    if (idx !== context.stack.length - 1) {
      // the event we're finishing isn't the most deeply nested one. warn the user.
    }
    this.eventStack = context.stack.slice(0, idx);
    this.sentEvents.push(payload);
  }

  addContext(map) {
    let context = tracker.getTracked();
    if (!context || context.stack.length === 0) {
      // valid, since we can end up in our instrumentation outside of requests we're tracking
      return;
    }
    Object.assign(context.stack[0], map);
  }

  // DEPRECATED
  // next major bump will remove this.  No replacement.
  removeContext(key) {
    let context = tracker.getTracked();
    if (!context || context.stack.length === 0) {
      // valid, since we can end up in our instrumentation outside of requests we're tracking
      return;
    }
    delete context.stack[0].payload[key];
  }

  addTraceContext(map) {
    Object.assign(this.traceContext, map);
  }

  // DEPRECATED
  // next major bump will remove this.  No replacement.
  removeTraceContext(key) {
    delete this.traceContext[key];
  }

  flush() {
    return Promise.resolve();
  }
};

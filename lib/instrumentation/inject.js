/* eslint-env node */
const tracker = require("../async_tracker"),
  api = require("../api");

/**
 *
 * @param {*} targetModule
 * @param {*} opts see example for format requirements
 *
 * For more complicated bits of instrumentation where you want direct access to the
 * underlying Honeycomb `api` and `tracker`. Not for the faint of heart!
 *
 * Using this requires passing options to the main config object.
 *
 *
 * @example require('honeycomb-beeline')({
 *   enabledInstrumetations: [
 *     'inject',
 *      'some-other-module'
 *   ],
 *   inject: new Map([
 *     [
 *       'some-other-module',
 *       {
 *         injected: true, // this flag is important!!
 *         setApi: (loadedModule, api) => (loadedModule.TESTING = api),
 *         setTracker: (loadedModule, tracker) => (loadedModule.TESTING_1 = tracker)
 *       }
 *     ]
 *   ])
 *  })
 */
const instrumentInjected = function(targetModule, opts = {}) {
  const { setTracker, setApi } = opts;

  setTracker(targetModule, tracker);
  setApi(targetModule, api);
  targetModule.__wrapped = true;
  return targetModule;
};

exports = module.exports = instrumentInjected;

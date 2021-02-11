const logDriver = require("log-driver");
const util = require("util");

let logger = null;

const create = (options) => {
  const _options = Object.assign(
    {
      debug: false,
      loglevel: "info",
      logname: "KNX",
      levels: ["error", "warn", "notice", "info", "debug", "trace"],
    },
    options
  );

  const levels = _options.levels;
  const level = _options.debug ? "debug" : _options.loglevel;
  const logname = _options.logname;
  return logDriver({
    levels,
    level,
    format(lvl, msg /* string */, ...a) {
      const ts = new Date().toISOString().replace(/T/, " ").replace(/Z$/, "");
      return util.format(
        "%s: [%s] %s " + msg,
        logname,
        lvl.toUpperCase(),
        ts,
        ...a
      );
    },
  });
};

module.exports = {
  get: (options) => logger || (logger = create(options)),
};

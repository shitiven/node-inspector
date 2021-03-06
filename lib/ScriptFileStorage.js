var fs = require('fs');
var path = require('path');
var async = require('async');
var glob = require('glob');
var debug = require('debug')('node-inspector:ScriptFileStorage');

var MODULE_HEADER = '(function (exports, require, module, __filename, __dirname) { ';
var MODULE_TRAILER = '\n});';
var MODULE_WRAP_REGEX = new RegExp(
  '^' + escapeRegex(MODULE_HEADER) +
    '([\\s\\S]*)' +
    escapeRegex(MODULE_TRAILER) + '$'
);

var CONVENTIONAL_DIRS_PATTERN = '{*.js,lib/**/*.js,node_modules/**/*.js,test/**/*.js}';
var ALL_JS_PATTERN = '**/*.js';

function escapeRegex(str) {
  return str.replace(/([/\\.?*()^${}|[\]])/g, '\\$1');
}

/**
 * @param {{preload}} config
 * @param {ScriptManager} scriptManager
 * @constructor
 */
function ScriptFileStorage(config, session) {
  config = config || {};
  this._scriptManager = session.scriptManager;
  this._noPreload = config.preload === false;
  this._preloadExclude = config.preloadExclude||[];
}

var $class = ScriptFileStorage.prototype;

$class.save = function(path, content, callback) {
  var match = MODULE_WRAP_REGEX.exec(content);
  if (!match) {
    callback(new Error('The new content is not a valid node.js script.'));
    return;
  }
  var newSource = match[1];
  async.waterfall([
    fs.readFile.bind(fs, path, 'utf-8'),

    function(oldContent, cb) {
      var match = /^(\#\!.*)/.exec(oldContent);
      if (match)
        newSource = match[1] + newSource;

      fs.writeFile(path, newSource, cb);
    }
  ],
  callback);
};

/**
 * @param {string} path
 * @param {function(Object, string)} callback
 */
$class.load = function(path, callback) {
  var scriptId = this._scriptManager.findScriptIdByPath(path);
  // If requested source was loaded in app (scriptId != null), we can't expect that it is equal
  // to the file with requested name stored in fs.
  // So, if requested source was loaded in app, we need to require it from app.
  if (scriptId != null) {
    this._scriptManager.getScriptSourceById(scriptId, callback);
  } else {
    fs.readFile(
      path,
      'utf-8',
      function(err, content) {
        if (err) return callback(err);

        // remove shebang
        content = content.replace(/^\#\!.*/, '');

        var source = MODULE_HEADER + content + MODULE_TRAILER;
        return callback(null, source);
      }
    );
  }
};

/**
 * @param {string} mainScriptFile
 * @param {function(Object, string)} callback
 * @this {ScriptFileStorage}
 */
$class.findApplicationRoot = function(mainScriptFile, callback) {
  fs.realpath(mainScriptFile, function(err, realPath) {
    if (err) {
      console.log('Cannot resolve real path of %s: %s', mainScriptFile, err);
      realPath = mainScriptFile;
    }
    this._findApplicationRootForRealFile(realPath, callback);
  }.bind(this));
};

/**
 * For a given script file, find the root directory containing all application
 * source files.
 *
 * Example:
 *   file = ~/work/app/bin/cli.js
 *   root = ~/work/app
 *
 * The algorithm:
 *
 * By default, we assume that the source file is in the root directory
 * (~/work/app/bin in the example above).
 *
 * If this directory does not contain 'package.json' and the parent directory
 * contains 'package.json', then we assume the parent directory is
 * the application root (~/work/app in the example above).
 *
 * @param {string} file
 * @param {function(Object, string)} callback
 * @this {ScriptFileStorage}
 */
$class._findApplicationRootForRealFile = function(file, callback) {
  var mainDir = path.dirname(file);
  var parentDir = path.dirname(mainDir);

  async.detect(
    [mainDir, parentDir],
    this._isApplicationRoot.bind(this),
    function(result) {
      callback(null, result || mainDir, !!result);
    }
  );
};

/**
 * @param {string} folder
 * @param {function(boolean)} callback
 */
$class._isApplicationRoot = function(folder, callback) {
  fs.exists(path.join(folder, 'package.json'), callback);
};

/**
 * @param {string} rootFolder
 * @param {string} pattern
 * @param {function(Object, Array.<string>?)} callback
 */
$class.listScripts = function(rootFolder, pattern, callback) {
  var last = this._lastList,
      that = this;

  if (last && last.rootFolder == rootFolder && last.pattern == pattern) {
    process.nextTick(function() { callback(last.error, last.result); });
    return;
  }


  debug('glob %s on %s', pattern, rootFolder);

  var preloadExcluded = function(file){
    if (!that._preloadExclude.length) return false;
    return that._preloadExclude.some(function(regexp){
      return regexp.test(file);
    });
  }

  var walk = function(dir, done) {
    var results = [];
    fs.readdir(dir, function(err, list) {
      if (err) return done(err);
      var pending = list.length;
      if (!pending) return done(null, results);
      list.forEach(function(file) {
        file = path.resolve(dir, file);
        if (preloadExcluded(file)) {
          if (!--pending) done(null, results);
          return;
        };
        fs.stat(file, function(err, stat) {

          if (stat && 
              stat.isDirectory()) {
            walk(file, function(err, res) {
              results = results.concat(res);
              if (!--pending) done(null, results);
            });
          } else {
            if (/\.js$/.test(file)) {
              results.push(file);
            };
            if (!--pending) done(null, results);
          }

        });
      });
    });
  };

  walk(rootFolder, function(err, result){

    var end_time = new Date().getTime();

    if (result) {
      result = result.map(function(unixPath) {
        return unixPath.split('/').join(path.sep);
      });
    }

    that._lastList = {
      rootFolder: rootFolder,
      pattern: pattern,
      error: err,
      result: result
    };

    debug('glob returned %s files', err || result.length);
    callback(err, result);

  });
  
};

$class._findScriptsOfRunningApp = function(mainScriptFile, callback) {
  if (!mainScriptFile) {
    // mainScriptFile is null when running in the REPL mode
    return process.nextTick(callback.bind(null, null, []));
  }

  async.waterfall(
    [
      this.findApplicationRoot.bind(this, mainScriptFile),
      function(dir, isRoot, cb) {
        var pattern = isRoot ? ALL_JS_PATTERN : CONVENTIONAL_DIRS_PATTERN;
        this.listScripts(dir, pattern, cb);
      }.bind(this)
    ],
    callback
  );
};

$class._findScriptsOfStartDirectoryApp = function(startDirectory, callback) {
  this._isApplicationRoot(
    startDirectory,
    function handleIsStartDirectoryApplicationRoot(result) {
      if (!result) {
        callback(null, []);
      } else {
        this.listScripts(startDirectory, ALL_JS_PATTERN, callback);
      }
    }.bind(this)
  );
};

/**
 * @param {string} startDirectory
 * @param {string} mainScriptFile
 * @param {function(Object, Array.<string>)} callback
 * @this {ScriptFileStorage}
 */
$class.findAllApplicationScripts = function(startDirectory, mainScriptFile, callback) {
  if (this._noPreload) {
    return process.nextTick(function() { callback(null, []); });
  }
  async.series(
    [
      this._findScriptsOfRunningApp.bind(this, mainScriptFile),
      this._findScriptsOfStartDirectoryApp.bind(this, startDirectory)
    ],
    function(err, results) {
      if (err) return callback(err);

      var files = results[0].concat(results[1]);
      // filter out duplicates and files to hide
      files = files.filter(function(elem, ix, arr) {
        return arr.indexOf(elem) >= ix && !this._scriptManager.isScriptHidden(elem);
      }.bind(this));

      debug('findAllApplicationScripts returned %s files', files.length);
      return callback(null, files);
    }.bind(this)
  );
};

exports.ScriptFileStorage = ScriptFileStorage;

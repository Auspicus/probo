var Promise = require('bluebird')
var events = require('events')
var util = require('util')

var intformat = require('biguint-format'), FlakeId = require('flake-idgen')
var flakeIdGen = new FlakeId() // id generator

/**
 * @class
 */
var AbstractPlugin = function(container, options) {
  if (this.constructor === AbstractPlugin) {
    throw new Error("Can't instantiate abstract class AbstractPlugin")
  }

  this.id = intformat(flakeIdGen.next(), 'hex')

  options = options || {}
  this.options = options
  this.container = container
  this.timeout = options.timeout || 6000
  this.plugin = this.constructor.name
  this.name = options.name || this.plugin + " task"

  // used for tracking result data such as exit code and and execution time
  this.result = {
    code: null,
    time: null
  }

  this.run = Promise.promisify(this.run.bind(this))
  this.log = this.container.log.child({component: `${this.plugin} [${this.name}]`})

  events.EventEmitter.call(this)
};

util.inherits(AbstractPlugin, events.EventEmitter)

/**
 * Returns a JSON representation of the plugin, which is used automatically with JSON.stringify.
 * List of JSONified properties can be overwridden with an array in 'this._json_attrs'.
 * @returns {object}
 */
AbstractPlugin.prototype.toJSON = function() {
  var ret = {}, props = this._json_attrs || ["id", "name", "plugin", "timeout", "options", "result"]
  for(var i = 0; i < props.length; i++){
    ret[props[i]] = this[props[i]]
  }
  return ret
}


/**
 * Build the command to run (as an Array). This method must be subclassed.
 * @returns {Array}
 */
AbstractPlugin.prototype.buildCommand = function() {
  throw new Error("AbstractPlugin.buildCommand must be implemented by a subclass")
};

/**
 * Return a description string for the task. By default returns an empty string
 * @returns {String}
 */
AbstractPlugin.prototype.description = function() {
  return ""
};

/**
 * Perform any necessary config for Docker exec. Called when the task runs.
 * @param {Array} [command=this.buildCommand()] - array of command parts to run in the docker container
 */
AbstractPlugin.prototype.buildOptions = function(command){
  if(!command){
    command = this.buildCommand()
  }

  return {
    // options for .exec
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: this.options.tty || false,

    // options for .start
    Detach: false,

    OpenStdout: true,

    // SSH errors were observed without having a PWD set.
    Env: this.options.env || [
      // Note: this is only used by some applications (like SSH) and
      // will not set the working directory for bash.
      'PWD=/src',
    ],
    Cmd: command,
  };
}

AbstractPlugin.prototype.handleTimeout = function() {
  this.log.warn({exec: this.exec}, "Task timedout")
};

/**
 * Runs the configured command in the container.
 *
 * Returns a promise (see {@link AbstractPlugin} constructor) that
 * resolves when the execution starts. The promise resolves with an
 * object having: (stream, exec, task). stream is a {@link Stream} of
 * bundled stdout/stderr, exec is a Promise that resolves with
 * Docker's Exec output when the command finishes (stream ends), and
 * task is set to 'this' (the plugin instance, aka task).
 *
 * @returns {Promise} (promisifed in constructor)
 */
AbstractPlugin.prototype.run = function(done) {
  // TODO: This is bad - I should call this dockerContainer or something...
  var container = this.container.container;
  var log = this.log

  var self = this;
  var start = +new Date()

  this.updateStatus({state: "pending", action: "running"})

  container.exec(self.buildOptions(), function(error, exec) {
    log.info('starting the exec');

    self.exec = exec;
    if(error) {
      return done(new Error("Failed to exec command: " + error.message));
    }

    exec.start({stream: true, stdin: true, stdout: true}, function(error, stream) {
      log.info('exec started');
      if(error) {
        return done(new Error("Failed to start command: " + error.message));
      }

      // TODO: Allow a write stream to be connected here.

      var finished = new Promise(function(resolve, reject){
        stream.on('end', function() {
          log.info('exec stream ended');

          exec.inspect(function(error, data) {
            if(error){ return reject(error) }

            log.info('exec completed with', data.ExitCode);

            resolve(data)
          });
        });
      })

      // monitor status of task
      finished.then(function(data){
        self.result.code = data.ExitCode
        self.result.time = +new Date() - start

        self.updateStatus({
          state: data.ExitCode === 0 ? "success" : "error",
          action: 'finished'
        })

        return data
      }).catch(function(e){
        self.result.time = +new Date() - start

        self.updateStatus({state: "error", action: "finished", description: e.message})
        throw e
      })

      // // configure a timeout
      // // TODO: kill the original process when we time out
      // finished = finished.timeout(self.timeout).catch(Promise.TimeoutError, function(e) {
      //   self.handleTimeout(e)
      // })

      self.process = {stream, exec: finished, task: self}
      self.emit("running", self.process)
      done(null, self.process)
    });
  });
};

/**
 * Call to emit an event that's a status update for the task
 * @param {Object} status - The status object (state, action, description)
 * @param {string} [context] - Optional context value to use. If not set, defaults to a sensible value.
 */
AbstractPlugin.prototype.updateStatus = function(status, context) {
  context = context || `${this.plugin}/${this.name}`
  status.description = status.description || this.description()
  status.task = this
  this.emit("update", context, status, this)
};

module.exports = AbstractPlugin;

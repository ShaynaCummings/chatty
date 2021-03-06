var _ = require('lodash');
var later = require('later');
var RSVP = require('rsvp');
var cliff = require('cliff');
var crypto = require('crypto');
var moment = require('moment-timezone');

module.exports = function (commander, logger) {

  commander.script({
    help: 'A command for executing other commands on a UTC schedule',
    start: start,
    stop: stop
  });

  commander.command({
    name: 'later',
    args: '[help]',
    help: 'Runs a command according to a UTC schedule',
    action: function (event, response) {
      var match;
      if (!event.input || /^help\b/i.test(event.input)) {
        return response.help('later', [
          '<laterjs-text-expr> /<command> [args]    <b>Note: UTC times required</b>',
          'cancel|stop <id>',
          'show|jobs'
        ]);
      } else if (match = /^(?:cancel|stop)\s+([\da-f]+)$/i.exec(event.input)) {
        cancel(event, response, match[1].trim());
      } else if (match = /^(?:jobs|show)\s*$/i.exec(event.input)) {
        show(event, response);
      } else if (match = /^([^\/]+)(\/[\w-]+(?:.*))/i.exec(event.input)) {
        var command = match[2].trim();
        if (command.indexOf('later') === 1) {
          return response.random([
            'Um, no.',
            'I think not.',
            'You have to be kidding me.',
            'Please, be realistic.',
            'Don\'t be ridiculous.'
          ], {color: 'red'});
        }
        add(event, response, match[1].trim(), command);
      } else {
        response.confused();
      }
    }
  });

  var jobs = {};

  function startJob(tenant, store, response, job, reply) {
    return new RSVP.Promise(function (resolve, reject) {
      try {
        later.date.UTC();
        var schedule = later.parse.text(job.spec);
        if (schedule.error === -1) {
          job.handle = later.setInterval(function () {
            logger.info('Executing job ' + job.id + ' for tenant ' + tenant.clientKey);
            commander.execute(job.command, tenant, job.from, response.send);
          }, schedule);
          resolve();
        } else {
          var err = new Error('Invalid schedule: "' + job.spec + '"');
          err.column = schedule.error;
          reject(err);
        }
      } catch (e) {
        reject(e);
      }
    }).then(function () {
      tenantJobs(tenant)[job.id] = job;
      logger.info('Started /later job ' + job.id + ' for tenant ' + tenant.clientKey);
      if (reply) {
        response.send('Ok, I scheduled that command');
      }
    }, function (err) {
      if (err.column >= 0) {
        response.send('Sorry, I didn\'t understand the schedule "' + job.spec + '": error at character ' + err.column + ' -- get help at http://bunkat.github.io/later/parsers.html#text');
        store.del(jobKey(job.id));
      } else {
        logger.error(err.stack || err);
      }
    });
  }

  function stopJob(tenant, store, response, id, found, reply) {
    var job = tenantJobs(tenant)[id];
    return new RSVP.Promise(function (resolve, reject) {
      delete tenantJobs(tenant)[id];
      if (job) {
        if (job.handle && job.handle.clear) {
          job.handle.clear();
        }
        resolve();
      } else if (found === 0) {
        response.send('Oh-oh, I couldn\'t find a job with id ' + id + '...');
        resolve();
      } else {
        reject(new Error('Failed to cancel job ' + id + ': not found'));
      }
    }).then(function () {
      if (job) {
        logger.info('Stopped /later job ' + id + ' for tenant ' + tenant.clientKey);
        if (reply) {
          response.send('Ok, I canceled that command');
        }
      }
    }, function (err) {
      logger.error(err.stack || err);
    });
  }

  function add(event, response, spec, command) {
    var seed = new Date() + '|' + spec + '|' + command;
    var id = crypto.createHash('sha1').update(seed).digest('hex').slice(0, 8);
    var job = {
      id: id,
      spec: spec,
      command: command,
      from: event.from
    };
    return event.store.set(jobKey(job.id), job).then(function () {
      event.store.publish('job-added', job.id);
    }, function (err) {
      if (err) logger.warn(err.stack || err);
      response.confused();
    });
  }

  function cancel(event, response, id) {
    return event.store.del(jobKey(id)).then(function (count) {
      event.store.publish('job-canceled', JSON.stringify({id: id, found: count}));
    }, function (err) {
      if (err) logger.warn(err.stack || err);
      response.confused();
    });
    return RSVP.all([]);
  }

  function show(event, response) {
    event.store.all().then(function (all) {
      var rows = _.map(all, function (job, key) {
        return key.indexOf('job-') === 0 ? [job.id, ' ', job.spec, ' ', job.command] : null;
      }).filter(function (row) {
        return !!row;
      }).sort(function (a, b) {
        return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0);
      });
      var msg;
      if (rows.length > 0) {
        rows.unshift(['ID', ' ', 'Schedule', ' ', 'Command']);
        msg = '<pre><b>Scheduled Jobs</b>\n' + cliff.stringifyRows(rows) + '</pre>';
      } else {
        msg = 'I don\'t have any jobs scheduled right now';
      }
      response.send(msg, {format: 'html'});
    });
  }

  function start(tenant, store, response) {
    commander.work(function () {
      store.all().then(function (all) {
        _.each(all, function (job, key) {
          if (key.indexOf('job-') === 0) {
            startJob(tenant, store, response, job);
          }
        });
      });
      store.subscribe('job-added', function (id) {
        store.get(jobKey(id)).then(function (job) {
          startJob(tenant, store, response, job, true);
        });
      });
      store.subscribe('job-canceled', function (json) {
        var payload = JSON.parse(json);
        stopJob(tenant, store, response, payload.id, payload.found, true);
      });
    });
  }

  function stop(tenant, store, response) {
    commander.work(function () {
      store.all().then(function (all) {
        _.each(all, function (job) {
          stopJob(tenant, store, response, job.id, 1, false);
        });
      });
      store.unsubscribe('job-added');
      store.unsubscribe('job-canceled');
    });
  }

  function jobKey(id) {
    return 'job-' + id;
  }

  function tenantJobs(tenant) {
    return jobs[tenant.clientKey] = jobs[tenant.clientKey] || {};
  }

};

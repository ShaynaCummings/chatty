module.exports = function (commander) {

  commander.command({
    name: 'chatty',
    args: '[commands|spies]',
    help: 'Prints this help message',
    opts: {format: 'html'},
    action: function (event, response) {
      response.send(commander.help(event.input || 'commands'));
    }
  });

};

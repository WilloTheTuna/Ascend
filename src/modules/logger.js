const fs = require('fs');
const path = require('path');

class Logger {
  constructor(appData) {
    this.logFile = path.join(appData, 'logs', 'rocketcroc.log');
    this.maxSize = 5 * 1024 * 1024; // 5MB rotate
    this.queue = [];
    this.writing = false;
    this._rotateInProgress = false;
  }

  _write(level, msg) {
    const line = `${new Date().toISOString()} [${level}] ${msg}\r\n`;
    process.stdout.write(line);
    
    this.queue.push(line);
    this._flush();
  }

  _flush() {
    if (this.writing || this.queue.length === 0 || this._rotateInProgress) return;
    this.writing = true;

    const toWrite = this.queue.join('');
    this.queue = [];

    fs.stat(this.logFile, (err, stats) => {
      if (!err && stats && stats.size > this.maxSize) {
        this._rotateInProgress = true;
        fs.rename(this.logFile, this.logFile + '.old', (renameErr) => {
          this._rotateInProgress = false;
          this._writeToLog(toWrite);
        });
      } else {
        this._writeToLog(toWrite);
      }
    });
  }

  _writeToLog(data) {
    fs.appendFile(this.logFile, data, (err) => {
      this.writing = false;
      if (this.queue.length > 0) {
        this._flush();
      }
    });
  }

  info(msg) { this._write('INFO', msg); }
  warn(msg) { this._write('WARN', msg); }
  error(msg) { this._write('ERROR', msg); }
}

module.exports = Logger;

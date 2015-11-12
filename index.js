'use strict';

var MODULE_NAME = 'gmusic';
var MODULE_TYPE = 'backend';

var PlayMusic = require('playmusic');
var mkdirp = require('mkdirp');
var https = require('https');
var fs = require('fs');
var ffmpeg = require('fluent-ffmpeg');
var stream = require('stream');

var nodeplayerConfig = require('nodeplayer').config;
var coreConfig = nodeplayerConfig.getConfig();
var defaultConfig = require('./default-config.js');
var config = nodeplayerConfig.getConfig(MODULE_TYPE + '-' + MODULE_NAME, defaultConfig);

var player;
var logger;

var gmusicBackend = {};
gmusicBackend.name = MODULE_NAME;

// TODO: seeking
var encodeSong = function(origStream, seek, song, progCallback, errCallback) {
    var incompletePath = coreConfig.songCachePath + '/gmusic/incomplete/' + song.songID + '.opus';
    var incompleteStream = fs.createWriteStream(incompletePath, {flags: 'w'});
    var encodedPath = coreConfig.songCachePath + '/gmusic/' + song.songID + '.opus';

    var command = ffmpeg(origStream)
        .noVideo()
        //.inputFormat('mp3')
        //.inputOption('-ac 2')
        .audioCodec('libopus')
        .audioBitrate('192')
        .format('opus')
        .on('error', function(err) {
            logger.error('error while transcoding ' + song.songID + ': ' + err);
            if (fs.existsSync(incompletePath)) {
                fs.unlinkSync(incompletePath);
            }
            errCallback(song, err);
        });

    var opusStream = command.pipe(null, {end: true});
    opusStream.on('data', function(chunk) {
        incompleteStream.write(chunk, undefined, function() {
            progCallback(song, chunk, false);
        });
    });
    opusStream.on('end', function() {
        incompleteStream.end(undefined, undefined, function() {
            logger.verbose('transcoding ended for ' + song.songID);

            // TODO: we don't know if transcoding ended successfully or not,
            // and there might be a race condition between errCallback deleting
            // the file and us trying to move it to the songCache

            // atomically move result to encodedPath
            if (fs.existsSync(incompletePath)) {
                fs.renameSync(incompletePath, encodedPath);
                progCallback(song, null, true);
            } else {
                progCallback(song, null, false);
            }
        });
    });

    logger.verbose('transcoding ' + song.songID + '...');
    return function(err) {
        command.kill();
        logger.verbose('canceled preparing: ' + song.songID + ': ' + err);
        if (fs.existsSync(incompletePath)) {
            fs.unlinkSync(incompletePath);
        }
        errCallback(song, 'canceled preparing: ' + song.songID + ': ' + err);
    };
};

var gmusicDownload = function(song, progCallback, errCallback) {
    var req = null;
    var gmusicStream = new stream.PassThrough();

    var doDownload = function(streamUrl) {
        if (streamUrl) {
            logger.debug('downloading song ' + song.songID);

            req = https.request(streamUrl, function(res) {
                res.pipe(gmusicStream, {end: false});

                res.on('end', function() {
                    if (res.statusCode === 302) { // redirect
                        logger.debug('redirected. retrying with new URL');
                        res.unpipe();
                        doDownload(res.headers.location);
                    } else if (res.statusCode === 200) {
                        logger.debug('download finished');
                        gmusicStream.end();
                    } else {
                        gmusicStream.end();
                        logger.error('unknown status code ' + res.statusCode);
                        if (errCallback) {
                            errCallback(song, 'unknown status code ' + res.statusCode);
                        }
                    }
                });
            });
            req.on('error', function(e) {
                logger.error(e + ' while fetching! reconnecting in 5s...');
                setTimeout(function() {
                    gmusicBackend.init(function() {
                        logger.error('error while fetching! now reconnected to gmusic');
                        gmusicBackend.pm.getStreamUrl(song.songID, function(err, streamUrl) {
                            if (err) {
                                errCallback(song, err);
                            } else {
                                doDownload(streamUrl);
                            }
                        });
                    });
                }, 5000);
            });
            req.end();
        } else {
            gmusicBackend.pm.getStreamUrl(song.songID, function(err, streamUrl) {
                if (err) {
                    errCallback(song, err);
                } else {
                    doDownload(streamUrl);
                }
            });
        }
    };

    /*
    return function(err) {
        // TODO: this doesn't seem to work very well...
        if (command)
            command.kill();
        if (req)
            req.abort();

        if (fs.existsSync(filePath))
            fs.unlinkSync(filePath);
        if (fs.existsSync(incompleteFilePath))
            fs.unlinkSync(incompleteFilePath);

        logger.verbose('canceled preparing: ' + songID + ': ' + err);

        errCallback();
    };
    */

    doDownload();

    var cancelEncoding = encodeSong(gmusicStream, 0, song, progCallback, errCallback);
    return function(err) {
        if (req) {
            req.abort();
        }
        cancelEncoding(err);
    };
};

// cache song to disk.
// on success: progCallback must be called with true as argument
// on failure: errCallback must be called with error message
// returns a function that cancels preparing
gmusicBackend.prepareSong = function(song, progCallback, errCallback) {
    var filePath = coreConfig.songCachePath + '/gmusic/' + song.songID + '.opus';

    if (fs.existsSync(filePath)) {
        // true as first argument because there is song data
        progCallback(song, true, true);
    } else {
        return gmusicDownload(song, progCallback, errCallback);
    }
};

gmusicBackend.isPrepared = function(song) {
    var filePath = coreConfig.songCachePath + '/gmusic/' + song.songID + '.opus';
    return fs.existsSync(filePath);
};

// search for music from the backend
// on success: callback must be called with a list of song objects
// on failure: errCallback must be called with error message
gmusicBackend.search = function(query, callback, errCallback) {
    var cnt = Math.min(100, coreConfig.searchResultCnt);
    gmusicBackend.pm.search(query.terms, cnt, function(err, data) {
        if (err) {
            errCallback(err);
            return;
        }

        var songs;
        var results = {};
        results.songs = {};

        if (data.entries) {
            songs = data.entries.filter(function(entry) {
                return entry.type === '1'; // songs only, no albums/artists
            });

            for (var i = 0; i < songs.length; i++) {
                results.songs[songs[i].track.nid] = {
                    artist: songs[i].track.artist,
                    title: songs[i].track.title,
                    album: songs[i].track.album,
                    albumArt: {
                        lq: songs[i].track.albumArtRef && songs[i].track.albumArtRef[0] ?
                            songs[i].track.albumArtRef[0].url + '=s60-e100-c' : null,
                        hq: songs[i].track.albumArtRef && songs[i].track.albumArtRef[0] ?
                            songs[i].track.albumArtRef[0].url : null
                    },
                    duration: songs[i].track.durationMillis,
                    songID: songs[i].track.nid,
                    score: songs[i].score,
                    backendName: MODULE_NAME,
                    format: 'opus'
                };
            }
        }

        callback(results);
    }, function(err) {
        errCallback('error while searching gmusic: ' + err);
    });
};

gmusicBackend.getPlaylists = function(callback) {
    gmusicBackend.pm.getPlayListEntries(function(err, data) {
        callback(err, data);
    });
};

// called when partyplay is started to initialize the backend
// do any necessary initialization here
gmusicBackend.init = function(_player, _logger, callback) {
    player = _player;
    logger = _logger;

    mkdirp.sync(coreConfig.songCachePath + '/gmusic/incomplete');

    // initialize google play music backend
    gmusicBackend.pm = new PlayMusic();
    gmusicBackend.pm.init(config, callback);
};

module.exports = gmusicBackend;

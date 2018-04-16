var unzip = require('unzip');
var util = require('util');
var url = require('url');
var mime = require('mime-types')
var uuidv4 = require('uuid/v4');

var _ = require('lodash');
var Busboy = require('busboy');
var GridFS = require('gridfs-stream');
var ZipStream = require('zip-stream');
var BSON = require('bson');
var mongodb = require('mongodb');
var MongoClient = mongodb.MongoClient;

var sharp = require('sharp');

module.exports = GridFSService;

function GridFSService(options) {
  if (!(this instanceof GridFSService)) {
    return new GridFSService(options);
  }

  this.options = options;
}

/**
 * Connect to mongodb if necessary.
 */
GridFSService.prototype.connect = function (cb) {
  var self = this;

  if (!this.db) {
    var url;
    
    self.options.host = self.options.host || self.options.hostname || 'localhost';
    self.options.port = self.options.port || 27017;

    if (!self.options.url) {
      url = (self.options.username && self.options.password) ?
        'mongodb://{$username}:{$password}@{$host}:{$port}/{$database}' :
        'mongodb://{$host}:{$port}/{$database}';

      // replace variables
      url = url.replace(/\{\$([a-zA-Z0-9]+)\}/g, function (pattern, option) {
        return self.options[option] || pattern;
      });
    } else {
      url = self.options.url;
    }

    // connect
    MongoClient.connect(url, self.options, function (error, db) {
      if (!error) {
        self.db = db;
      }
      return cb(error, db);
    });
  }
};

/**
 * List all storage containers.
 */
GridFSService.prototype.getContainers = function (cb) {
  var collection = this.db.collection('fs.files');

  collection.find({
    'metadata.container': { $exists: true }
  }).toArray(function (error, files) {
    var containerList = [];

    if (!error) {
      containerList = _(files)
        .map('metadata.container').uniq().value();
    }

    return cb(error, containerList);
  });
};


/**
 * Delete an existing storage container.
 */
GridFSService.prototype.deleteContainer = function (container, cb) {
  var collection = this.db.collection('fs.files');

  collection.deleteMany({
    'metadata.container': container
  }, function (error) {
    return cb(error);
  });
};


/**
 * List all files within the given container.
 */
GridFSService.prototype.getFiles = function (container, cb) {
  var collection = this.db.collection('fs.files');

  collection.find({
    'metadata.container': container
  }).toArray(function (error, container) {
    return cb(error, container);
  });
};


/**
 * Return a file with the given id within the given container.
 */
GridFSService.prototype.getFile = function (container, id, cb) {
  var collection = this.db.collection('fs.files');

  collection.find({
    '_id': new mongodb.ObjectID(id),
    'metadata.container': container
  }).limit(1).next(function (error, file) {
    if (!file) {
      error = new Error('File not found');
      error.status = 404;
    }
    return cb(error, file || {});
  });
};


/**
 * Delete an existing file with the given id within the given container.
 */
GridFSService.prototype.deleteFile = function (container, id, cb) {
  var collection = this.db.collection('fs.files');

  collection.deleteOne({
    '_id': new mongodb.ObjectID(id),
    'metadata.container': container
  }, function (error) {
    return cb(error);
  });
};


/**
 * Upload middleware for the HTTP request.
 */
GridFSService.prototype.upload = function (container, req, cb) {
  var self = this;

  var busboy = new Busboy({
    headers: req.headers
  });

  busboy.on('file', function (fieldname, file, filename, encoding, mimetype) {
    var options = {
      _id: new mongodb.ObjectID(),
      contentType: mime.lookup(filename),
      filename: filename,
      metadata: {
        container: container,
        filename: filename,
        mimetype: mime.lookup(filename),
      },
      mode: 'w'
    };

    var gridfs = new GridFS(self.db, mongodb);
    var stream = gridfs.createWriteStream(options);

    stream.on('close', function (file) {
      return cb(null, file);
    });

    stream.on('error', cb);

    file.pipe(stream);
  });

  req.pipe(busboy);
};

/**
 * Upload ZIP archive middleware for the HTTP request.
 */
GridFSService.prototype.uploadArchive = function (container, req, cb) {
  var self = this;

  var busboy = new Busboy({
    headers: req.headers
  });

  var gridfs = new GridFS(self.db, mongodb);
  var uuid = uuidv4();
  var entriesP = [];

  busboy.on('file', function (fieldname, file, filename, encoding, mimetype) {
    file.pipe(unzip.Parse()).on('entry', function (entry) {
      if(entry.type !== 'File')
        return entry.autodrain();

      var entryFileName = entry.path.split(/[\\/]/).pop();
      var options = {
        _id: new mongodb.ObjectID(),
        contentType: mime.lookup(entryFileName),
        filename: entryFileName,
        metadata: {
          container: container,
          filename: entryFileName,
          mimetype: mime.lookup(entryFileName),
          uuid: uuid
        },
        mode: 'w'
      };

      var stream = gridfs.createWriteStream(options);
      entriesP.push(new Promise((resolve, reject) => {
        stream.on('close', resolve);
        stream.on('error', reject);
      }));

      if (['image/png', 'image/jpg', 'image/gif', 'image/jpeg'].indexOf(options.metadata.mimetype) > -1) {
        entry.pipe(sharp().resize(1000, 1000).max()).pipe(stream);
      } else {
        entry.pipe(stream);
      }
    }).on('close', function(err) {
      return Promise.all(entriesP).then(entries => {
        return cb(null, entries);
      }).catch(cb);
    }).on('error', function(err) {
      return cb(err);
    });
  });

  req.pipe(busboy);
};


/**
 * Download middleware for the HTTP request.
 */
GridFSService.prototype.download = function (container, id, res, cb) {
  var self = this;

  var collection = this.db.collection('fs.files');
  var query = {
    'metadata.container': container,
  };

  if(BSON.ObjectID.isValid(id))
    query['_id'] = new mongodb.ObjectID(id)
  else
    query['filename'] = id;

  collection.find(query).limit(1).next(function (error, file) {
    if (!file) {
      error = new Error('File not found.');
      error.status = 404;
    }

    if (error) {
      return cb(error);
    }

    var gridfs = new GridFS(self.db, mongodb);
    var stream = gridfs.createReadStream({
      _id: file._id
    });

    // set headers
    res.set('Content-Type', file.metadata.mimetype);
    res.set('Content-Length', file.length);

    return stream.pipe(res);
  });
};

GridFSService.prototype.downloadContainer = function (container, req, res, cb) {
  var self = this;

  var collection = this.db.collection('fs.files');

  collection.find({
    'metadata.container': container
  }).toArray(function (error, files) {
    if (files.length === 0) {
      error = new Error('No files to archive.');
      error.status = 404;
    }

    if (error) {
      return cb(error);
    }

    var gridfs = new GridFS(self.db, mongodb);
    var archive = new ZipStream();
    var archiveSize = 0;

    function next() {
      if (files.length > 0) {
        var file = files.pop();
        var fileStream = gridfs.createReadStream({ _id: file._id });

        archive.entry(fileStream, { name: file.filename }, next);
      } else {
        archive.finish();
      }
    }

    next();

    var filename = req.query.filename || 'file';

    res.set('Content-Disposition', `attachment;filename=${filename}.zip`);
    res.set('Content-Type', 'application/zip');

    return archive.pipe(res);
  });
};


GridFSService.modelName = 'storage';

/*
 * Routing options
 */

/*
 * GET /FileContainers
 */
GridFSService.prototype.getContainers.shared = true;
GridFSService.prototype.getContainers.accepts = [];
GridFSService.prototype.getContainers.returns = {
  arg: 'containers',
  type: 'array',
  root: true
};
GridFSService.prototype.getContainers.http = {
  verb: 'get',
  path: '/'
};

/*
 * DELETE /FileContainers/:container
 */
GridFSService.prototype.deleteContainer.shared = true;
GridFSService.prototype.deleteContainer.accepts = [
  { arg: 'container', type: 'string', description: 'Container name' }
];
GridFSService.prototype.deleteContainer.returns = {};
GridFSService.prototype.deleteContainer.http = {
  verb: 'delete',
  path: '/:container'
};

/*
 * GET /FileContainers/:container/files
 */
GridFSService.prototype.getFiles.shared = true;
GridFSService.prototype.getFiles.accepts = [
  { arg: 'container', type: 'string', description: 'Container name' }
];
GridFSService.prototype.getFiles.returns = {
  type: 'array',
  root: true
};
GridFSService.prototype.getFiles.http = {
  verb: 'get',
  path: '/:container/files'
};

/*
 * GET /FileContainers/:container/files/:id
 */
GridFSService.prototype.getFile.shared = true;
GridFSService.prototype.getFile.accepts = [
  { arg: 'container', type: 'string', description: 'Container name' },
  { arg: 'id', type: 'string', description: 'File id' }
];
GridFSService.prototype.getFile.returns = {
  type: 'object',
  root: true
};
GridFSService.prototype.getFile.http = {
  verb: 'get',
  path: '/:container/files/:id'
};

/*
 * DELETE /FileContainers/:container/files/:id
 */
GridFSService.prototype.deleteFile.shared = true;
GridFSService.prototype.deleteFile.accepts = [
  { arg: 'container', type: 'string', description: 'Container name' },
  { arg: 'id', type: 'string', description: 'File id' }
];
GridFSService.prototype.deleteFile.returns = {};
GridFSService.prototype.deleteFile.http = {
  verb: 'delete',
  path: '/:container/files/:id'
};

/*
 * POST /FileContainers/:container/upload
 */
GridFSService.prototype.upload.shared = true;
GridFSService.prototype.upload.accepts = [
  { arg: 'container', type: 'string', description: 'Container name' },
  { arg: 'req', type: 'object', http: { source: 'req' } }
];
GridFSService.prototype.upload.returns = {
  arg: 'file',
  type: 'object',
  root: true
};
GridFSService.prototype.upload.http = {
  verb: 'post',
  path: '/:container/upload'
};

/*
 * POST /FileContainers/:container/uploadArchive
 */
GridFSService.prototype.uploadArchive.shared = true;
GridFSService.prototype.uploadArchive.accepts = [
  { arg: 'container', type: 'string', description: 'Container name' },
  { arg: 'req', type: 'object', http: { source: 'req' } }
];
GridFSService.prototype.uploadArchive.returns = {
  type: 'array',
  root: true
};
GridFSService.prototype.uploadArchive.http = {
  verb: 'post',
  path: '/:container/uploadArchive'
};

/*
 * GET /FileContainers/:container/download/:id
 */
GridFSService.prototype.download.shared = true;
GridFSService.prototype.download.accepts = [
  { arg: 'container', type: 'string', description: 'Container name' },
  { arg: 'id', type: 'string', description: 'File id' },
  { arg: 'res', type: 'object', 'http': { source: 'res' } }
];
GridFSService.prototype.download.http = {
  verb: 'get',
  path: '/:container/download/:id'
};

/*
 * GET /FileContainers/:container/download/zip
 */
GridFSService.prototype.downloadContainer.shared = true;
GridFSService.prototype.downloadContainer.accepts = [
  { arg: 'container', type: 'string', description: 'Container name' },
  { arg: 'req', type: 'object', 'http': { source: 'req' } },
  { arg: 'res', type: 'object', 'http': { source: 'res' } }
];
GridFSService.prototype.downloadContainer.http = {
  verb: 'get',
  path: '/:container/zip'
};

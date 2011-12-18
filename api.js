////////////////////////////////////////////////////////////////////////////
// DAVE API Framweork in node.js
// Evan Tahler @ Fall 2011

////////////////////////////////////////////////////////////////////////////
// Init
function initRequires(api, next)
{
	autoReloadFileInit(api, ["utils"], "./utils.js", "utils");
	autoReloadFileInit(api, ["log"], "./logger.js", "log");
	autoReloadFileInit(api, ["tasks"], "./tasks.js", "tasks");
	autoReloadFileInit(api, ["cache"], "./cache.js", "cache");

	next();
}

////////////////////////////////////////////////////////////////////////////
// Init logging folder
function initLogFolder(api, next)
{
	try { api.fs.mkdirSync(api.configData.logFolder, "777") } catch(e) {}; 
	next();
}

////////////////////////////////////////////////////////////////////////////
// DB setup
function initDB(api, next)
{
	api.dbObj = new api.SequelizeBase(api.configData.database.database, api.configData.database.username, api.configData.database.password, {
		host: api.configData.database.host,
		port: api.configData.database.port,
		logging: api.configData.database.consoleLogging
	});

	api.rawDBConnction = api.mysql.createClient({
	  user: api.configData.database.username,
	  password: api.configData.database.password,
	  port: api.configData.database.port,
	  host: api.configData.database.host
	});
	api.rawDBConnction.query('USE '+api.configData.database.database);

	api.models = {};
	api.seeds = {};
	api.modelsArray = [];
	api.fs.readdirSync("./models").forEach( function(file) {
		var modelName = file.split(".")[0];
		api.models[modelName] = require("./models/" + file)['defineModel'](api);
		api.seeds[modelName] = require("./models/" + file)['defineSeeds'](api);
		api.modelsArray.push(modelName); 
		if (api.cluster.isMaster) { api.log("model loaded: " + modelName, "blue"); }
	});
	api.dbObj.sync().on('success', function() {
		for(var i in api.seeds)
		{
			var seeds = api.seeds[i];
			var model = api.models[i];
			if (seeds != null)
			{
				api.utils.DBSeed(api, model, seeds, function(seeded, modelResp){
					if (api.cluster.isMaster) { if(seeded){ api.log("Seeded data for: "+modelResp.name, "cyan"); } }
				});
			}
		}
		if (api.cluster.isMaster) { api.log("DB conneciton sucessfull and Objects mapped to DB tables", "green"); }
		next();
	}).on('failure', function(error) {
		api.log("trouble synchronizing models and DB.  Correct DB credentials?", "red");
		api.log(JSON.stringify(error));
		api.log("exiting", "red");
		process.exit(1);
	})
}

////////////////////////////////////////////////////////////////////////////
// postVariable config and load
function initPostVariables(api, next)
{
	api.postVariables = api.configData.postVariables || [];
	for(var model in api.models){
		for(var attr in api.models[model].rawAttributes){
			api.postVariables.push(attr);
		}
	}
	next();
}

////////////////////////////////////////////////////////////////////////////
// populate actions
function initActions(api, next)
{
	api.actions = {};
	api.fs.readdirSync("./actions").forEach( function(file) {
		if (file != ".DS_Store"){
			var actionName = file.split(".")[0];
			var thisAction = require("./actions/" + file)["action"];
			autoReloadFileInit(api, ["actions", thisAction.name], ("./actions/" + file), "action");
			if (api.cluster.isMaster) { api.log("action loaded: " + actionName, "blue"); }
		}
	});
	next();
}

////////////////////////////////////////////////////////////////////////////
// Periodic Tasks (fixed timer events)
function initCron(api, next)
{
	if (api.configData.cronProcess)
	{
		autoReloadFileInit(api, ["processCron"], "./cron.js", "processCron");
		api.cronTimer = setTimeout(api.processCron, api.configData.cronTimeInterval, api);
		api.log("periodic (internal cron) interval set to process evey " + api.configData.cronTimeInterval + "ms", "green");
	}
	next();
}


////////////////////////////////////////////////////////////////////////////
// Generic Action processing
function processAction(connection, next)
{
	var templateValidator = require('validator').Validator;
	connection.validator = new templateValidator();
	connection.validator.error = function(msg){ connection.error = msg; };
	
	api.models.log.count({where: ["ip = ? AND createdAt > (NOW() - INTERVAL 1 HOUR)", connection.remoteIP]}).on('success', function(requestThisHourSoFar) {
		connection.requestCounter = requestThisHourSoFar + 1;
		if(connection.params.limit == null){ connection.params.limit = api.configData.defaultLimit; }
		if(connection.params.offset == null){ connection.params.offset = api.configData.defaultOffset; }
		if(api.configData.logRequests){api.log("action @ " + connection.remoteIP + " | params: " + JSON.stringify(connection.params));}
		if(connection.requestCounter <= api.configData.apiRequestLimit || api.configData.logRequests == false)
		{
			connection.action = undefined;
			if(connection.params["action"] == undefined){
				connection.error = "You must provide an action. Use action=describeActions to see a list.";
				process.nextTick(function() { next(connection, true); });
			}
			else{
				connection.action = connection.params["action"];
				if(api.actions[connection.action] != undefined){
					process.nextTick(function() { api.actions[connection.action].run(api, connection, next); });
				}else{
					connection.error = connection.action + " is not a known action. Use action=describeActions to see a list.";
					process.nextTick(function() { next(connection, true); });
				}
			}
		}else{
			connection.requestCounter = api.configData.apiRequestLimit;
			connection.error = "You have exceded the limit of " + api.configData.apiRequestLimit + " requests this hour.";
			process.nextTick(function() { next(connection, true); });
		}
	});
}

function logAction(connection){
	var logRecord = api.models.log.build({
		ip: connection.remoteIP,
		action: connection.action,
		error: connection.error,
		params: JSON.stringify(connection.params)
	});
	process.nextTick(function() { logRecord.save(); });
}

////////////////////////////////////////////////////////////////////////////
// Web Request Processing
function initWebListen(api, next)
{
	api.webApp.listen(api.configData.webServerPort);
	api.webApp.use(api.expressServer.bodyParser());
	api.webApp.all('/*', function(req, res, next){
		api.stats.numberOfWebRequests = api.stats.numberOfWebRequests + 1;
		
		var connection = {};
		
		connection.type = "web";
		connection.timer = {};
		connection.timer.startTime = new Date().getTime();
		connection.req = req;
		connection.res = res;
		connection.response = {}; // the data returned from the API
		connection.error = false; 	// errors and requst state
		connection.remoteIP = connection.req.connection.remoteAddress;
		connection.contentType = "application/json";
		connection.res.header("X-Powered-By",api.configData.serverName);
		if(connection.req.headers['x-forwarded-for'] != null)
		{
			connection.remoteIP = connection.req.headers['x-forwarded-for'];	
		}
		
		connection.params = {};
		api.postVariables.forEach(function(postVar){
			connection.params[postVar] = connection.req.param(postVar);
			if (connection.params[postVar] === undefined){ connection.params[postVar] = connection.req.cookies[postVar]; }
		});
		
		if(connection.params["action"] == undefined){
			connection.params["action"] = connection.req.params[0].split("/")[0];
		}
		
		// ignore proxy tests
		if(connection.params["action"] == "status" && connection.remoteIP == "127.0.0.1"){
			connection.res.send("OK");
		}else{
			if(connection.req.form){
				if (connection.req.body == null || api.utils.hashLength(connection.req.body) == 0){
					connection.req.form.complete(function(err, fields, files){
						api.postVariables.forEach(function(postVar){
							if(fields[postVar] != null && fields[postVar].length > 0){ connection.params[postVar] = fields[postVar]; }
						});
						connection.req.files = files;
						process.nextTick(function() { processAction(connection, api.respondToWebClient); });
					});
				}else{
 					api.postVariables.forEach(function(postVar){ 
						if(connection.req.body[postVar] != null && connection.req.body[postVar].length > 0){ connection.params[postVar] = connection.req.body[postVar]; }
					});
					process.nextTick(function() { processAction(connection, api.respondToWebClient); });
				}
			}else{
				process.nextTick(function() { processAction(connection, api.respondToWebClient); });
			}
		}
	});
	
	api.respondToWebClient = function(connection, cont){
		if(cont != false)
		{
			var response = api.buildWebResponse(connection);
	  		try{
	  			connection.res.header('Content-Type', connection.contentType);
				process.nextTick(function() { connection.res.send(response); });
			}catch(e)
			{
				
			}
			// if(api.configData.logRequests){api.log(" > web request from " + connection.remoteIP + " | response: " + JSON.stringify(response), "grey");}
			if(api.configData.logRequests){api.log(" > web request from " + connection.remoteIP + " | responded in : " + connection.response.serverInformation.requestDuration + "ms", "grey");}
		}
		process.nextTick(function() { logAction(connection); });
	};
	
	api.buildWebResponse = function(connection)
	{	
		connection.response = connection.response || {};
			
		// serverInformation information
		connection.response.serverInformation = {};
		connection.response.serverInformation.serverName = this.configData.serverName;
		connection.response.serverInformation.apiVerson = this.configData.apiVerson;
		
		// requestorInformation
		connection.response.requestorInformation = {};
		connection.response.requestorInformation.remoteAddress = connection.remoteIP;
		connection.response.requestorInformation.RequestsRemaining = this.configData.apiRequestLimit - connection.requestCounter;
		connection.response.requestorInformation.recievedParams = {};
		for(var k in connection.params){
			if(connection.params[k] != undefined){
				connection.response.requestorInformation.recievedParams[k] = connection.params[k] ;
			}
		};
		
		// request timer
		connection.timer.stopTime = new Date().getTime();
		connection.response.serverInformation.requestDuration = connection.timer.stopTime - connection.timer.startTime;
			
		// errors
		if(connection.error == false){
			connection.response.error = "OK";
		}
		else{
			connection.response.error = connection.error;
		}
			
		if(connection.params.callback != null){
			connection.contentType = "application/javascript";
			return connection.params.callback + "(" + JSON.stringify(connection.response) + ");";
		}
		
		return JSON.stringify(connection.response);
	};
	
	next();
}

////////////////////////////////////////////////////////////////////////////
// Socket Request Processing
function initSocketServerListen(api, next){
	api.gameListeners = {}

	api.socketServer = api.net.createServer(function (connection) {
		api.stats.numberOfSocketRequests = api.stats.numberOfSocketRequests + 1;
	  	connection.setEncoding("utf8");
	  	connection.type = "socket";
		connection.params = {};
		connection.remoteIP = connection.remoteAddress;
		connection.id = connection.remoteAddress + "@" + connection.remotePort;
	
	  	connection.on("connect", function () {
	    	api.sendSocketMessage(connection, {welcome: api.configData.socketServerWelcomeMessage});
	    	api.log("socket connection "+connection.remoteIP+" | connected");
	  	});
	  	connection.on("data", function (data) {
			var data = data.replace(/(\r\n|\n|\r)/gm,"");
			var words = data.split(" ");
	    	if(words[0] == "quit" || words[0] == "exit" || words[0] == "close" || data.indexOf("\u0004") > -1 ){
				api.sendSocketMessage(connection, {status: "Bye!"});
				connection.end();
				api.log("socket connection "+connection.remoteIP+" | requesting disconnect");
			}else if(words[0] == "paramAdd"){
				var parts = words[1].split("=");
				connection.params[parts[0]] = parts[1];
				api.sendSocketMessage(connection, {status: "OK"});
				api.log("socket connection "+connection.remoteIP+" | "+data);
			}else if(words[0] == "paramDelete"){
				connection.data.params[words[1]] = null;
				api.sendSocketMessage(connection, {status: "OK"});
				api.log("socket connection "+connection.remoteIP+" | "+data);
			}else if(words[0] == "paramView"){
				var q = words[1];
				api.sendSocketMessage(connection, {q: connection.params[q]});
				api.log("socket connection "+connection.remoteIP+" | "+data);
			}else if(words[0] == "paramsView"){
				api.sendSocketMessage(connection, connection.params);
				api.log("socket connection "+connection.remoteIP+" | "+data);
			}else if(words[0] == "paramsDelete"){
				connection.params = {};
				api.sendSocketMessage(connection, {status: "OK"});
				api.log("socket connection "+connection.remoteIP+" | "+data);
			}else{
				connection.error = false;
				connection.response = {};
				// if(connection.params["action"] == null || words.length == 1){connection.params["action"] = words[0];}
				connection.params["action"] = words[0];
				process.nextTick(function() { processAction(connection, api.respondToSocketClient); });
				api.log("socket connection "+connection.remoteIP+" | "+data);
			}
	  	});
	  	connection.on("end", function () {
	    	connection.end();
			api.log("socket connection "+connection.remoteIP+" | disconnected");
	  	});
	});
	
	// action response helper
	api.respondToSocketClient = function(connection, cont){
		if(cont != false)
		{
			if(connection.error == false){
				if(connection.response == {}){
					connection.response = {status: "OK"};
				}
				api.sendSocketMessage(connection, connection.response);
			}else{
				api.sendSocketMessage(connection, {error: connection.error});
			}
		}
		process.nextTick(function() { logAction(connection); });
	}
	
	//message helper
	api.sendSocketMessage = function(connection, message){
		process.nextTick(function() { 
			try{ connection.write(JSON.stringify(message) + "\r\n\0"); }catch(e){ }
		});
	}
	
	// listen
	api.socketServer.listen(api.configData.socketServerPort);
	
	next();
}
 
////////////////////////////////////////////////////////////////////////////
// final flag
function initMasterComplete(api){
	api.log("");
	api.log("*** Master Started @ " + api.utils.sqlDateTime() + " @ web port " + api.configData.webServerPort + " & socket port " + api.configData.socketServerPort + " ***", ["green", "bold"]);
	api.log("Starting workers:");
	api.log("");
	for (var i = 0; i < api.os.cpus().length; i++) {
	    api.cluster.fork();
	}
}

function initWorkerComplete(api){
	api.log("worker pid "+process.pid+" started", "green");
}

////////////////////////////////////////////////////////////////////////////
// am I runnign already?
function runningCheck(api, next){
	api.utils.shellExec(api, "ps awx | grep api.js | grep -v '/bin/sh' | grep -v grep --count", function(response){
		if(response.stdout > 1){
			api.utils.shellExec(api, "ps awx | grep api.js | grep -v grep", function(response){
				api.log("*** The server is already running, exiting this instance ***", "yellow");
				process.exit(0);
			});
		}else{
			next();
		}
	});
}

////////////////////////////////////////////////////////////////////////////
// autoReload
function autoReloadFileInit(api, apiVariables, path, theMethod){
	if(api.configData.autoReloadFiles){
		api.fs.watchFile(path, function () {
			// console.log("*** "+path+" has changed, reloading module");
			delete(require.cache[require.resolve(path)]);
			if(apiVariables.length == 1){
				api[apiVariables[0]] = require(path)[theMethod];
			}else if(apiVariables.length == 2){
				api[apiVariables[0]][apiVariables[1]] = require(path)[theMethod];
			}
		});
	}

	if(apiVariables.length == 1){
		api[apiVariables[0]] = require(path)[theMethod];
	}else if(apiVariables.length == 2){
		api[apiVariables[0]][apiVariables[1]] = require(path)[theMethod];
	}
}

////////////////////////////////////////////////////////////////////////////
// GO!

// Force NPM to be update... you probably don't want this in production
// exec = require('child_process').exec
// exec("npm update");

process.chdir(__dirname);

var api = api = api || {}; // the api namespace.  Everything uses this.

api.util = require("util");
api.exec = require('child_process').exec;
api.net = require("net");
api.http = require("http");
api.url = require("url");
api.path = require("path");
api.fs = require("fs");
api.cluster = require("cluster");
api.os = require('os');
api.mysql = require('mysql');
api.SequelizeBase = require("sequelize");
api.expressServer = require('express');
api.form = require('connect-form');
api.async = require('async');
api.crypto = require("crypto");
api.consoleColors = require('colors');

api.webApp = api.expressServer.createServer(
	api.form({ keepExtensions: true })
);
api.webApp.use(api.expressServer.cookieParser());
api.configData = JSON.parse(api.fs.readFileSync('config.json','utf8'));

process.argv.forEach(function (val, index, array) {
  if(val == "test"){
  	for (var i in api.configData.testVariables){
  		api.configData[i] = api.configData.testVariables[i];
  	}
  }
});

api.stats = {};
api.stats.numberOfWebRequests = 0;
api.stats.numberOfSocketRequests = 0;
api.stats.startTime = new Date().getTime();

if (api.cluster.isMaster) {
	initLogFolder(api, function(){
		initRequires(api, function(){
			runningCheck(api, function(){
				initCron(api, function(){
					initDB(api, function(){
						initPostVariables(api, function(){
							initActions(api, function(){
								initMasterComplete(api);
							});
						});
					});
				});
			});
		});
	});

	api.cluster.on('death', function(worker) {
		console.log('worker ' + worker.pid + ' died');
	});
}else{
	initLogFolder(api, function(){
		initRequires(api, function(){
			initDB(api, function(){
				initPostVariables(api, function(){
					initActions(api, function(){
						initWebListen(api, function(){
							initSocketServerListen(api, function(){
								initWorkerComplete(api);
							});
						});
					});
				});
			});
		});
	});
}
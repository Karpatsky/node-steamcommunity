var Request = require('request');
var RSA = require('node-bignumber').Key;
var hex2b64 = require('node-bignumber').hex2b64;
var SteamID = require('steamid');

const USER_AGENT = "Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/47.0.2526.106 Safari/537.36";

require('util').inherits(SteamCommunity, require('events').EventEmitter);

module.exports = SteamCommunity;

SteamCommunity.SteamID = SteamID;

function SteamCommunity(options) {
	options = options || {};

	this._jar = Request.jar();
	this._captchaGid = -1;
	this.chatState = SteamCommunity.ChatState.Offline;

	var defaults = {
		"jar": this._jar,
		"timeout": options.timeout || 50000,
		"gzip": true,
		"headers": {
			"User-Agent": options.userAgent || USER_AGENT
		}
	};

	if (typeof options == "string") {
		options = {
			localAddress: options
		};
	}
	this._options = options;

	if (options.localAddress) {
		defaults.localAddress = options.localAddress;
	}

	this.request = options.request || Request.defaults();
	this.request = this.request.defaults(defaults);

	// English
	this._jar.setCookie(Request.cookie('Steam_Language=english'), 'https://steamcommunity.com');

	// UTC
	this._jar.setCookie(Request.cookie('timezoneOffset=0,0'), 'https://steamcommunity.com');
}

SteamCommunity.prototype.login = function(details, callback) {
	if(details.steamguard) {
		var parts = details.steamguard.split('||');
		this._jar.setCookie(Request.cookie('steamMachineAuth' + parts[0] + '=' + encodeURIComponent(parts[1])), 'https://steamcommunity.com');
	}
	
	var self = this;

	// headers required to convince steam that we're logging in from a mobile device so that we can get the oAuth data
	var mobileHeaders = {
		"X-Requested-With": "com.valvesoftware.android.steam.community",
		"Referer": "https://steamcommunity.com/mobilelogin?oauth_client_id=DE45CD61&oauth_scope=read_profile%20write_profile%20read_client%20write_client",
		"User-Agent": "Mozilla/5.0 (Linux; U; Android 4.1.1; en-us; Google Nexus 4 - 4.1.1 - API 16 - 768x1280 Build/JRO03S) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30",
		"Accept": "text/javascript, text/html, application/xml, text/xml, */*"
	};

	this._jar.setCookie(Request.cookie("mobileClientVersion=0 (2.1.3)"), "https://steamcommunity.com");
	this._jar.setCookie(Request.cookie("mobileClient=android"), "https://steamcommunity.com");
	
	this.request.post("https://steamcommunity.com/login/getrsakey/", {
		"form": {"username": details.accountName},
		"headers": mobileHeaders,
		"json": true
	}, function(err, response, body) {
		// Remove the mobile cookies
		if (self._checkHttpError(err, response, callback)) {
			deleteMobileCookies();
			return;
		}

		if(!body.publickey_mod || !body.publickey_exp) {
			deleteMobileCookies();
			callback(new Error("Invalid RSA key received"));
			return;
		}
		
		var key = new RSA();
		key.setPublic(body.publickey_mod, body.publickey_exp);
		
		var form = {
			"captcha_text": details.captcha || "",
			"captchagid": self._captchaGid,
			"emailauth": details.authCode || "",
			"emailsteamid": "",
			"password": hex2b64(key.encrypt(details.password)),
			"remember_login": "true",
			"rsatimestamp": body.timestamp,
			"twofactorcode": details.twoFactorCode || "",
			"username": details.accountName,
			"oauth_client_id": "DE45CD61",
			"oauth_scope": "read_profile write_profile read_client write_client",
			"loginfriendlyname": "#login_emailauth_friendlyname_mobile"
		};
		
		self.request.post({
			"uri": "https://steamcommunity.com/login/dologin/",
			"json": true,
			"form": form,
			"headers": mobileHeaders
		}, function(err, response, body) {
			deleteMobileCookies();

			if(self._checkHttpError(err, response, callback)) {
				return;
			}
			
			if(!body.success && body.emailauth_needed) {
				// Steam Guard (email)
				var error = new Error("SteamGuard");
				error.emaildomain = body.emaildomain;
				
				callback(error);
			} else if(!body.success && body.requires_twofactor) {
				// Steam Guard (app)
				callback(new Error("SteamGuardMobile"));
			} else if(!body.success && body.captcha_needed) {
				var error = new Error("CAPTCHA");
				error.captchaurl = "https://steamcommunity.com/public/captcha.php?gid=" + body.captcha_gid;
				
				self._captchaGid = body.captcha_gid;
				
				callback(error);
			} else if(!body.success) {
				callback(new Error(body.message || "Unknown error"));
			} else {
				var sessionID = generateSessionID();
				var oAuth = JSON.parse( body.oauth );
				self._jar.setCookie(Request.cookie('sessionid=' + sessionID), 'http://steamcommunity.com');
				
				self.steamID = new SteamID(oAuth.steamid);
				self.oAuthToken = oAuth.oauth_token;

				var cookies = self._jar.getCookieString("https://steamcommunity.com").split(';').map(function(cookie) {
					return cookie.trim();
				});
				
				// Find the Steam Guard cookie
				var steamguard = null;
				for(var i = 0; i < cookies.length; i++) {
					var parts = cookies[i].split('=');
					if(parts[0] == 'steamMachineAuth' + self.steamID) {
						steamguard = self.steamID.toString() + '||' + decodeURIComponent(parts[1]);
						break;
					}
				}
				
				callback(null, sessionID, cookies, steamguard, oAuth.oauth_token);
			}
		});
	});

	function deleteMobileCookies() {
		var cookie = Request.cookie('mobileClientVersion=');
		cookie.expires = new Date(0);
		self._jar.setCookie(cookie, "https://steamcommunity.com");

		cookie = Request.cookie('mobileClient=');
		cookie.expires = new Date(0);
		self._jar.setCookie(cookie, "https://steamcommunity.com");
	}
};

SteamCommunity.prototype.oAuthLogin = function(steamguard, token, callback) {
	steamguard = steamguard.split('||');
	var steamID = new SteamID(steamguard[0]);

	var self = this;
	this.request.post({
		"uri": "https://api.steampowered.com/IMobileAuthService/GetWGToken/v1/",
		"form": {
			"access_token": token
		},
		"json": true
	}, function(err, response, body) {
		if(self._checkHttpError(err, response, callback)) {
			return;
		}

		if(!body.response || !body.response.token || !body.response.token_secure) {
			callback(new Error("Malformed response"));
			return;
		}

		var cookies = [
			'steamLogin=' + encodeURIComponent(steamID.getSteamID64() + '||' + body.response.token),
			'steamLoginSecure=' + encodeURIComponent(steamID.getSteamID64() + '||' + body.response.token_secure),
			'steamMachineAuth' + steamID.getSteamID64() + '=' + steamguard[1],
			'sessionid=' + self.getSessionID()
		];

		self.setCookies(cookies);
		callback(null, self.getSessionID(), cookies);
	});
};

SteamCommunity.prototype.setCookies = function(cookies) {
	var self = this;
	cookies.forEach(function(cookie) {
		var cookieName = cookie.match(/(.+)=/)[1];
		if(cookieName == 'steamLogin') {
			self.steamID = new SteamID(cookie.match(/=(\d+)/)[1]);
		}
		
		self._jar.setCookie(Request.cookie(cookie), (cookieName.match(/^steamMachineAuth/) || cookieName.match(/Secure$/) ? "https://" : "http://") + "steamcommunity.com");
	});
};

SteamCommunity.prototype.getSessionID = function() {
	var cookies = this._jar.getCookieString("http://steamcommunity.com").split(';');
	for(var i = 0; i < cookies.length; i++) {
		var match = cookies[i].trim().match(/([^=]+)=(.+)/);
		if(match[1] == 'sessionid') {
			return decodeURIComponent(match[2]);
		}
	}
	
	var sessionID = generateSessionID();
	this._jar.setCookie(Request.cookie('sessionid=' + sessionID), "http://steamcommunity.com");
	return sessionID;
};

function generateSessionID() {
	return require('crypto').randomBytes(12).toString('hex');
}

SteamCommunity.prototype.parentalUnlock = function(pin, callback) {
	this.request.post("https://steamcommunity.com/parental/ajaxunlock", {
		"json": true,
		"form": {
			"pin": pin
		}
	}, function(err, response, body) {
		if(!callback) {
			return;
		}
		
		if(self._checkHttpError(err, response, callback)) {
			return;
		}
		
		if(!body || typeof body.success !== 'boolean') {
			return callback("Invalid response");
		}
		
		if(!body.success) {
			return callback("Incorrect PIN");
		}
		
		callback();
	}.bind(this));
};

SteamCommunity.prototype.getNotifications = function(callback) {
	var self = this;
	this.request.get("https://steamcommunity.com/actions/RefreshNotificationArea", function(err, response, body) {
		if(self._checkHttpError(err, response, callback)) {
			return;
		}
		
		var notifications = {
			"comments": 0,
			"items": 0,
			"invites": 0,
			"gifts": 0,
			"chat": 0,
			"trades": 0
		};
		
		var items = {
			"comments": /(\d+) new comments?/,
			"items": /(\d+) new items? in your inventory/,
			"invites": /(\d+) new invites?/,
			"gifts": /(\d+) new gifts?/,
			"chat": /(\d+) unread chat messages?/,
			"trades": /(\d+) new trade notifications?/
		};
		
		var match;
		for(var i in items) {
			if(match = body.match(items[i])) {
				notifications[i] = parseInt(match[1], 10);
			}
		}
		
		callback(null, notifications);
	});
};

SteamCommunity.prototype.resetItemNotifications = function(callback) {
	var self = this;
	this.request.get("https://steamcommunity.com/my/inventory", function(err, response, body) {
		if(!callback) {
			return;
		}
		
		if(self._checkHttpError(err, response, callback)) {
			return;
		}
		
		callback(null);
	});
};

SteamCommunity.prototype.loggedIn = function(callback) {
	this.request("https://steamcommunity.com/my", {"followRedirect": false}, function(err, response, body) {
		if(err || (response.statusCode != 302 && response.statusCode != 403)) {
			callback(err || new Error("HTTP error " + response.statusCode));
			return;
		}
		
		if(response.statusCode == 403) {
			callback(null, true, true);
			return;
		}
		
		callback(null, !!response.headers.location.match(/steamcommunity\.com(\/(id|profiles)\/[^\/]+)\/?/), false);
	});
};

SteamCommunity.prototype._checkCommunityError = function(html, callback) {
	if(html.match(/<h1>Sorry!<\/h1>/)) {
		var match = html.match(/<h3>(.+)<\/h3>/);
		callback(new Error(match ? match[1] : "Unknown error occurred"));
		return true;
	}
	
	return false;
};

SteamCommunity.prototype._myProfile = function(endpoint, form, callback) {
	var self = this;
	this.request("https://steamcommunity.com/my", {"followRedirect": false}, function(err, response, body) {
		if(err || response.statusCode != 302) {
			callback(err || "HTTP error " + response.statusCode);
			return;
		}
		
		var match = response.headers.location.match(/steamcommunity\.com(\/(id|profiles)\/[^\/]+)\/?/);
		if(!match) {
			callback(new Error("Can't get profile URL"));
			return;
		}
		
		(form ? self.request.post : self.request)("https://steamcommunity.com" + match[1] + "/" + endpoint, form ? {"form": form} : {}, callback);
	});
};

SteamCommunity.prototype._checkHttpError = function(err, response, callback) {
	if(err) {
		callback(err);
		return true;
	}
	
	if(response.statusCode >= 300 && response.statusCode <= 399 && response.headers.location.indexOf('/login') != -1) {
		callback(new Error("Not Logged In"));
		return true;
	}
	
	if(response.statusCode >= 400) {
		var error = new Error("HTTP error " + response.statusCode);
		error.code = response.statusCode;
		callback(error);
		return true;
	}
	
	return false;
};

require('./components/chat.js');
require('./components/profile.js');
require('./components/market.js');
require('./components/groups.js');
require('./components/users.js');
require('./components/inventoryhistory.js');
require('./components/webapi.js');
require('./components/twofactor.js');
require('./components/confirmations.js');
require('./classes/CMarketItem.js');
require('./classes/CMarketSearchResult.js');
require('./classes/CSteamGroup.js');
require('./classes/CSteamUser.js');

/**
 @callback SteamCommunity~genericErrorCallback
 @param {Error|null} err - An Error object on failure, or null on success
 */
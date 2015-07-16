/* jslint node: true */
'use strict';

var MailPacket		= require('./mail_packet.js');
var ftn				= require('./ftn_util.js');
var Message			= require('./message.js');

var _				= require('lodash');
var assert			= require('assert');
var binary			= require('binary');
var fs				= require('fs');
var util			= require('util');
var async			= require('async');

//
//	References
//	* http://ftsc.org/docs/fts-0001.016
//	* http://ftsc.org/docs/fsc-0048.002
//
//	Other implementations:
//	* https://github.com/M-griffin/PyPacketMail/blob/master/PyPacketMail.py
//
function FTNMailPacket(options) {

	MailPacket.call(this, options);
	
	var self			= this;
	self.KLUDGE_PREFIX	= '\x01';

	/*
	this.loadNodeAddresses = function() {
		if(Config.networks) {
			for(var name in Config.networks) {
				if(!Config.networks[name].address) {
					continue;
				}

				this.nodeAddresses[name] = Config.networks[name].address;
			}
		}
	};

	this.loadNodeAddresses();
	*/

	this.getPacketHeaderAddress = function() {
		return {
			zone	: self.packetHeader.destZone,
			net		: self.packetHeader.destNet,
			node	: self.packetHeader.destNode,
			point	: self.packetHeader.destPoint,
		};
	};

	this.getNetworkNameForAddress = function(addr) {
		var nodeAddr;
		for(var network in self.nodeAddresses) {
			nodeAddr = self.nodeAddresses[network];
			if(nodeAddr.zone === addr.zone &&
				nodeAddr.net === addr.net &&
				nodeAddr.node === addr.node &&
				nodeAddr.point === addr.point)
			{
				return network;
			}
		}
	};

	this.parseFtnPacketHeader = function(packetBuffer, cb) {
		assert(Buffer.isBuffer(packetBuffer));

		if(packetBuffer.length < 58) {
			cb(new Error('Buffer too small'));
			return;		
		}

		binary.parse(packetBuffer)
			.word16lu('origNode')
			.word16lu('destNode')
			.word16lu('year')
			.word16lu('month')
			.word16lu('day')
			.word16lu('hour')
			.word16lu('minute')
			.word16lu('second')
			.word16lu('baud')
			.word16lu('packetType')
			.word16lu('originNet')
			.word16lu('destNet')
			.word8('prodCodeLo')
			.word8('revisionMajor')	//	aka serialNo
			.buffer('password', 8)	//	null terminated C style string
			.word16lu('origZone')
			.word16lu('destZone')
			//	Additions in FSC-0048.002 follow...
			.word16lu('auxNet')
			.word16lu('capWordA')
			.word8('prodCodeHi')
			.word8('revisionMinor')
			.word16lu('capWordB')
			.word16lu('originZone2')
			.word16lu('destZone2')
			.word16lu('originPoint')
			.word16lu('destPoint')
			.word32lu('prodData')
			.tap(function tapped(packetHeader) {
				packetHeader.password = ftn.stringFromFTN(packetHeader.password);

				//	:TODO: Don't hard code magic # here
				if(2 !== packetHeader.packetType) {
					cb(new Error('Packet is not Type-2'));
					return;
				}

				//	:TODO: validate & pass error if failure
				cb(null, packetHeader);
			});
	};

	self.getMessageMeta = function(msgData) {
		return {};	//	:TODO: convert msgData kludges/etc. -> Message meta
	};

	this.parseFtnMessageBody = function(msgBodyBuffer, cb) {
		//	:TODO: Look at spec about line endings/etc. Prob \r\n|[\r\n]|<someOlderAndAmigaStuff>

		//	:TODO: Use the proper encoding here. There appear to be multiple specs and/or
		//	stuff people do with this... some specs kludge lines, which is kinda durpy since
		//	to get to that point, one must read the file (and decode) to find said kludge...
		var msgLines	= msgBodyBuffer.toString().split(/\r\n|[\n\v\f\r\x85\u2028\u2029]/g);

		var msgBody = {
			message		: [],
			seenBy		: [],
			kludgeLines	: {},	//	upper(kludge) -> [ value, ... ]
		};

		var preOrigin	= true;

		function addKludgeLine(kl) {
			var kludgeParts = kl.split(':');
			kludgeParts[0]	= kludgeParts[0].toUpperCase();
			kludgeParts[1]	= kludgeParts[1].trim();

			if(!(kludgeParts[0] in msgBody.kludgeLines)) {
				msgBody.kludgeLines[kludgeParts[0]] = [ kludgeParts[1] ];
			} else {
				msgBody.kludgeLines[kludgeParts[0]].push(kludgeParts[1]);
			}
		};

		//	:TODO: should 0x8d "soft line feeds" be removed?

		msgLines.forEach(function nextLine(line) {
			if(0 === line.length) {
				msgBody.message.push('');
				return;
			}

			if(preOrigin) {
				if(_.startsWith(line, 'AREA:')) {
					msgBody.area = line.substring(line.indexOf(':') + 1).trim();
				} else if(_.startsWith(line, '--- ')) {
					//	Tag lines are tracked allowing for specialized display/etc.
					msgBody.tagLine = line;
				} else if(/[ ]{1,2}(\* )?Origin\: /.test(line)) {	//	To spec is "  * Origin: ..."
					msgBody.originLine = line;
					preOrigin		= false;
				} else if(self.KLUDGE_PREFIX === line.charAt(0)) {
					addKludgeLine(line.slice(1));
				} else {
					msgBody.message.push(line);
				}
				//	:TODO: SAUCE/etc. can be present?
			} else {
				if(_.startsWith(line, 'SEEN-BY:')) {
					msgBody.seenBy.push(line.substring(line.indexOf(':') + 1).trim());
				} else if(self.KLUDGE_PREFIX === line.charAt(0)) {
					addKludgeLine(line.slice(1));
				} 
			}
		});

		cb(null, msgBody);
	};

	this.extractMessages = function(buffer, cb) {
		var nullTermBuf		= new Buffer( [ 0 ] );

		binary.stream(buffer).loop(function looper(end, vars) {
			this
				.word16lu('messageType')
				.word16lu('originNode')
				.word16lu('destNode')
				.word16lu('originNet')
				.word16lu('destNet')
				.word8('attrFlags1')
				.word8('attrFlags2')
				.word16lu('cost')
				.scan('modDateTime', nullTermBuf)
				.scan('toUserName', nullTermBuf)
				.scan('fromUserName', nullTermBuf)
				.scan('subject', nullTermBuf)
				.scan('message', nullTermBuf)
				.tap(function tapped(msgData) {
					if(!msgData.originNode) {
						end();
						cb(null);
						return;
					}

					//	buffer to string conversion
					//	:TODO: What is the real encoding here?
					[ 'modDateTime', 'toUserName', 'fromUserName', 'subject', ].forEach(function field(f) {
						msgData[f] = msgData[f].toString();
					});

					self.parseFtnMessageBody(msgData.message, function msgBodyParsed(err, msgBody) {
						//
						//	Now, create a Message object
						//
						var msg = new Message( {
							toUserName			: msgData.toUserName,
							fromUserName		: msgData.fromUserName,
							subject				: msgData.subject,
							message				: msgBody.message.join('\n'),	//	:TODO: \r\n is better?
							modTimestamp		: ftn.getDateFromFtnDateTime(msgData.modDateTime),
							meta				: self.getMessageMeta(msgData),
						});

						self.emit('message', msg);	//	:TODO: Placeholder
					});		
				});
		});
	};

	this.parseFtnMessages = function(buffer, cb) {
		var nullTermBuf		= new Buffer( [ 0 ] );
		var fidoMessages	= [];

		binary.stream(buffer).loop(function looper(end, vars) {
			this
				.word16lu('messageType')
				.word16lu('originNode')
				.word16lu('destNode')
				.word16lu('originNet')
				.word16lu('destNet')
				.word8('attrFlags1')
				.word8('attrFlags2')
				.word16lu('cost')
				.scan('modDateTime', nullTermBuf)
				.scan('toUserName', nullTermBuf)
				.scan('fromUserName', nullTermBuf)
				.scan('subject', nullTermBuf)
				.scan('message', nullTermBuf)
				.tap(function tapped(msgData) {
					if(!msgData.originNode) {
						end();
						cb(null, fidoMessages);
						return;
					}

					//	buffer to string conversion
					//	:TODO: What is the real encoding here?
					[ 'modDateTime', 'toUserName', 'fromUserName', 'subject', ].forEach(function field(f) {
						msgData[f] = msgData[f].toString();
					});

					self.parseFtnMessageBody(msgData.message, function msgBodyParsed(err, msgBody) {
						msgData.message = msgBody;
						fidoMessages.push(_.clone(msgData));
					});		
				});
		});	
	};

	this.extractMesssagesFromPacketBuffer = function(packetBuffer, cb) {
		async.waterfall(
			[
				function parseHeader(callback) {
					self.parseFtnPacketHeader(packetBuffer, function headerParsed(err, packetHeader) {
						self.packetHeader = packetHeader;
						callback(err);
					});
				},
				function validateDesinationAddress(callback) {
					self.localNetworkName = self.getNetworkNameForAddress(self.getPacketHeaderAddress());
					self.localNetworkName = 'AllowAnyNetworkForDebugging';
					callback(self.localNetworkName ? null : new Error('Packet not addressed do this system'));
				},
				function extractEmbeddedMessages(callback) {
					//	note: packet header is 58 bytes in length
					self.extractMessages(packetBuffer.slice(58), function extracted(err) {
						callback(err);
					});
				}
			],
			function complete(err) {
				cb(err);
			}
		);
	};

	this.loadMessagesFromPacketBuffer = function(packetBuffer, cb) {
		async.waterfall(
			[
				function parseHeader(callback) {
					self.parseFtnPacketHeader(packetBuffer, function headerParsed(err, packetHeader) {
						self.packetHeader = packetHeader;
						callback(err);
					});
				},
				function validateDesinationAddress(callback) {
					self.localNetworkName = self.getNetworkNameForAddress(self.getPacketHeaderAddress());
					self.localNetworkName = 'AllowAnyNetworkForDebugging';
					callback(self.localNetworkName ? null : new Error('Packet not addressed do this system'));
				},
				function parseMessages(callback) {
					self.parseFtnMessages(packetBuffer.slice(58), function messagesParsed(err, fidoMessages) {
						callback(err, fidoMessages);
					});
				},
				function createMessageObjects(fidoMessages, callback) {
					fidoMessages.forEach(function msg(fmsg) {
						console.log(fmsg);
					});
				}
			],
			function complete(err) {
				cb(err);
			}
		);
	};
}

require('util').inherits(FTNMailPacket, MailPacket);

FTNMailPacket.prototype.parse = function(path, cb) {
	var self = this;

	async.waterfall(
		[
			function readFromFile(callback) {
				fs.readFile(path, function packetData(err, data) {
					callback(err, data);
				});
			},
			function extractMessages(data, callback) {
				self.loadMessagesFromPacketBuffer(data, function extracted(err, messages) {
					callback(err, messages);
				});
			}
		],
		function complete(err, messages) {
			cb(err, messages);
		}
	);
};

FTNMailPacket.prototype.read = function(options) {
	FTNMailPacket.super_.prototype.read.call(this, options);

	var self = this;

	if(_.isString(options.packetPath)) {
		async.waterfall(
			[
				function readPacketFile(callback) {
					fs.readFile(options.packetPath, function packetData(err, data) {
						callback(err, data);
					});
				},
				function extractMessages(data, callback) {
					self.extractMesssagesFromPacketBuffer(data, function extracted(err) {
						callback(err);
					});
				}
			],
			function complete(err) {
				if(err) {
					self.emit('error', err);
				}
			}
		);		
	} else if(Buffer.isBuffer(options.packetBuffer)) {

	}
};

FTNMailPacket.prototype.write = function(options) {
	FTNMailPacket.super_.prototype.write.call(this, options);
};


var mailPacket = new FTNMailPacket(
	{
		nodeAddresses : {
			fidoNet : {
				zone	: 46,
				net		: 1,
				node	: 140,
				point 	: 0,
				domain	: ''
			}
		}
	}
);

mailPacket.on('message', function msgParsed(msg) {
	console.log(msg);
});

mailPacket.read( { packetPath : '/home/nuskooler/ownCloud/Projects/ENiGMA½ BBS/FTNPackets/BAD_BNDL.007' } );

/*
mailPacket.parse('/home/nuskooler/ownCloud/Projects/ENiGMA½ BBS/FTNPackets/BAD_BNDL.007', function parsed(err, messages) {
	console.log(err)
});
*/
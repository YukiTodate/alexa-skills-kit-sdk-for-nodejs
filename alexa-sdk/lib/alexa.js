'use strict';

var EventEmitter = require('events').EventEmitter;
var util = require('util');
var attributesHelper = require('./DynamoAttributesHelper');
var responseHandlers = require('./response');
var _StateString = 'STATE';

function AlexaRequestEmitter() {
    EventEmitter.call(this);
}

util.inherits(AlexaRequestEmitter, EventEmitter);

function alexaRequestHandler(event, context, callback) {
    if (!event.session) {
        event.session = { 'attributes': {} };
    } else if (!event.session['attributes']) {
        event.session['attributes'] = {};
    }

    var handler = new AlexaRequestEmitter();
    handler.setMaxListeners(Infinity);

    Object.defineProperty(handler, '_event', {
        value: event,
        writable: false
    });

    Object.defineProperty(handler, '_context', {
        value: context,
        writable: false
    });

    Object.defineProperty(handler, '_callback', {
        value: callback,
        writable: false
    });

    Object.defineProperty(handler, 'state', {
        value: null,
        writable: true
    });

    Object.defineProperty(handler, 'appId', {
        value: null,
        writable: true
    });

    Object.defineProperty(handler, 'response', {
        value: {},
        writable: true
    });

    Object.defineProperty(handler, 'dynamoDBTableName', {
        value: null,
        writable: true
    });

    Object.defineProperty(handler, 'saveBeforeResponse', {
        value: false,
        writable: true
    });

    Object.defineProperty(handler, 'registerHandlers', {
        value: function() {
            RegisterHandlers.apply(handler, arguments);
        },
        writable: false
    });

    Object.defineProperty(handler, 'execute', {
        value: function() {
            HandleLambdaEvent.call(handler);
        },
        writable: false
    });

    handler.registerHandlers(responseHandlers);

    return handler;
}

function HandleLambdaEvent() {
    var event = this._event;
    var context = this._context;
    var handlerAppId = this.appId;
    var requestAppId = event.context.System.application.applicationId;

    if(!handlerAppId){
        console.log('Warning: Application ID is not set');
    }

    try {
        // Validate that this request originated from authorized source.
        if (handlerAppId && (requestAppId !== handlerAppId)) {
            console.log(`The applicationIds don\'t match: ${requestAppId} and ${handlerAppId}`);
            return context.fail('Invalid ApplicationId: ' + handlerAppId);
        }

        if(this.dynamoDBTableName && (!event.session.sessionId || event.session['new']) ) {
            attributesHelper.get(this.dynamoDBTableName, event.context.System.user.userId, (err, data) => {
                if(err) {
                    return context.fail('Error fetching user state: ' + err);
                }

                Object.assign(this._event.session.attributes, data);

                EmitEvent.call(this);
            });
        } else {
            EmitEvent.call(this);
        }
    } catch (e) {
        console.log(`Unexpected exception '${e}':\n${e.stack}`);
        context.fail(e);
    }
}

function EmitEvent() {
    this.state = this._event.session.attributes[_StateString] || '';

    var eventString = '';

    if (this._event.session['new'] && this.listenerCount('NewSession' + this.state) === 1) {
        eventString = 'NewSession';
    } else if(this._event.request.type === 'LaunchRequest') {
        eventString = 'LaunchRequest';
    } else if(this._event.request.type === 'IntentRequest') {
        eventString = this._event.request.intent.name;
    } else if (this._event.request.type === 'SessionEndedRequest'){
        eventString = 'SessionEndedRequest';
    } else if (this._event.request.type.substring(0,11) === 'AudioPlayer') {
        eventString = this._event.request.type.substring(12);
    } else if (this._event.request.type.substring(0,18) === 'PlaybackController') {
        eventString = this._event.request.type.substring(19);
    }

    eventString += this.state;

    if(this.listenerCount(eventString) < 1) {
        eventString = 'Unhandled' + this.state;
    }

    if(this.listenerCount(eventString) < 1){
        throw new Error(`No 'Unhandled' function defined for event: ${eventString}`);
    }

    this.emit(eventString);
}

function RegisterHandlers() {
    for(var arg = 0; arg < arguments.length; arg++) {
        var handlerObject = arguments[arg];

        if(!isObject(handlerObject)) {
            throw new Error(`Argument #${arg} was not an Object`);
        }

        var eventNames = Object.keys(handlerObject);

        for(var i = 0; i < eventNames.length; i++) {
            if(typeof(handlerObject[eventNames[i]]) !== 'function') {
                throw new Error(`Event handler for '${eventNames[i]}' was not a function`);
            }

            var eventName = eventNames[i];

            if(handlerObject[_StateString]) {
                eventName += handlerObject[_StateString];
            }
            var handlerContext = {
                on: this.on.bind(this),
                emit: this.emit.bind(this),
                emitWithState: EmitWithState.bind(this),
                state: this.state,
                handler: this,
                event: this._event,
                attributes: this._event.session.attributes,
                context: this._context,
                name: eventName,
                isOverridden:  IsOverridden.bind(this, eventName),
                response: ResponseBuilder(this)
            };

            this.on(eventName, handlerObject[eventNames[i]].bind(handlerContext));
        }
    }
}

function isObject(obj) {
    return (!!obj) && (obj.constructor === Object);
}

function IsOverridden(name) {
    return this.listenerCount(name) > 1;
}

function ResponseBuilder(self) {
    var responseObject = self.response;
    responseObject.version = '1.0';
    responseObject.response = {
        shouldEndSession: true
    };
    responseObject.sessionAttributes = self._event.session.attributes;

    return (function () {
        return {
            'speak': function (speechOutput) {
                responseObject.response.outputSpeech = createSSMLSpeechObject(speechOutput);
                return this;
            },
            'listen': function (repromptSpeech) {
                responseObject.response.reprompt = {
                    outputSpeech: createSSMLSpeechObject(repromptSpeech)
                };
                responseObject.response.shouldEndSession = false;
                return this;
            },
            'cardRenderer': function (cardTitle, cardContent, cardImage) {
                var card = {
                    type: 'Simple',
                    title: cardTitle,
                    content: cardContent
                };

                if(cardImage && (cardImage.smallImageUrl || cardImage.largeImageUrl)) {
                    card.type = 'Standard';
                    card['image'] = {};

                    delete card.content;
                    card.text = cardContent;

                    if(cardImage.smallImageUrl) {
                        card.image['smallImageUrl'] = cardImage.smallImageUrl;
                    }

                    if(cardImage.largeImageUrl) {
                        card.image['largeImageUrl'] = cardImage.largeImageUrl;
                    }
                }

                responseObject.response.card = card;
                return this;
            },
            'linkAccountCard': function () {
                responseObject.response.card = {
                    type: 'LinkAccount'
                };
                return this;
            },
            'audioPlayer': function (directiveType, behavior, url, token, expectedPreviousToken, offsetInMilliseconds) {
                var audioPlayerDirective;
                if (directiveType === 'play') {
                    audioPlayerDirective = {
                        "type": "AudioPlayer.Play",
                        "playBehavior": behavior,
                        "audioItem": {
                            "stream": {
                                "url": url,
                                "token": token,
                                "expectedPreviousToken": expectedPreviousToken,
                                "offsetInMilliseconds": offsetInMilliseconds
                            }
                        }
                    };
                } else if (directive === 'stop') {
                    audioPlayerDirective = {
                        "type": "AudioPlayer.Stop"
                    };
                } else {
                    audioPlayerDirective = {
                        "type": "AudioPlayer.Stop",
                        "clearBehavior": behavior
                    };
                }

                responseObject.response.directives = [audioPlayerDirective];
                return this;
            },
            'audioPlayerPlay': function (behavior, url, token, expectedPreviousToken, offsetInMilliseconds) {
                var audioPlayerDirective = {
                    "type": "AudioPlayer.Play",
                    "playBehavior": behavior,
                    "audioItem": {
                        "stream": {
                            "url": url,
                            "token": token,
                            "expectedPreviousToken": expectedPreviousToken,
                            "offsetInMilliseconds": offsetInMilliseconds
                        }
                    }
                };

                responseObject.response.directives = [audioPlayerDirective];
                return this;
            },
            'audioPlayerStop': function () {
                var audioPlayerDirective = {
                    "type": "AudioPlayer.Stop"
                };

                responseObject.response.directives = [audioPlayerDirective];
                return this;
            },
            'audioPlayerClearQueue': function (clearBehavior) {
                var audioPlayerDirective = {
                    "type": "AudioPlayer.ClearQueue",
                    "playBehavior": clearBehavior
                };

                responseObject.response.directives = [audioPlayerDirective];
                return this;
            }
        }
    })();
}

function createSSMLSpeechObject(message) {
    return {
        type: 'SSML',
        ssml: `<speak> ${message} </speak>`
    };
}

function createStateHandler(state, obj){
    if(!obj) {
        obj = {};
    }

    Object.defineProperty(obj, _StateString, {
        value: state || ''
    });

    return obj;
}

function EmitWithState() {
    if(arguments.length === 0) {
        throw new Error('EmitWithState called without arguments');
    }
    arguments[0] = arguments[0] + this.state;
    this.emit.apply(this, arguments);
}

process.on('uncaughtException', function(err) {
    console.log(`Uncaught exception: ${err}\n${err.stack}`);
    throw err;
});

module.exports.LambdaHandler = alexaRequestHandler;
module.exports.CreateStateHandler = createStateHandler;
module.exports.StateString = _StateString;
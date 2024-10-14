/**
 *
 * nuki adapter
 *
 *
/* jshint -W097 */// jshint strict:false
/*jslint node: true */
'use strict';

// you have to require the utils module and call adapter function
var utils       = require('@iobroker/adapter-core'); // Get common adapter utils
var express     = require('express');        // call express
var bodyParser  = require("body-parser");
var request     = require('request');
var crypto      = require('crypto');
var xsalsa      = require('xsalsa20');
var nacl        = require('tweetnacl'); // cryptographic functions
var buffer      = require("buffer");
// nacl.utils      = require('tweetnacl-util'); // encoding & decoding 
// var nsecret     = require('tweetnacl.secret');

// const _sodium   = require('libsodium-wrappers');

// REST server
var app     = express();
var timer   = null;
var ipInfo  = require('ip');
var hostIp  = ipInfo.address();

// Global variables
var bridgeId        = null;
var bridgeType      = 0;
var bridgeHwId      = null;
var bridgeFwVer     = null;
var bridgeWifiFwVer = null;
var bridgeAppVer    = null;
var bridgeIp        = null;
var bridgePort      = '0';
var bridgeToken     = null;
var forcePlainToken = null;
var bridgeName      = null;
var interval        = null;
var hostCb          = null;
var cbSet           = false;
var callbackId      = null;
var hostPort        = null;
var timeOut         = 3000;
var actionTimeOut, sleepTimeOut;

var semver = require('semver');

// you have to call the adapter function and pass a options object
// name has to be set and has to be equal to adapters folder name and main file name excluding extension
// adapter will be restarted automatically every time as the configuration changed, e.g system.adapter.template.0
//var adapter = new utils.Adapter('nuki');
let adapter;
function startAdapter(options) {
    options = options || {};
    Object.assign(options, {name: 'nuki'});
    adapter = new utils.Adapter(options);

    //adapter.log.debug('Adapter generated');
    
//    adapter.useFormatDate = true;   // load from ;system.config the global date format

    // Some message was sent to adapter instance over message box. Used by email, pushover, text2speech, ...
    adapter.on('message', function (obj) {
        if (typeof obj === 'object' && obj.message) {
            if (obj.command === 'send') {
                // e.g. send email or pushover or whatever
                console.log('send command');

                // Send response in callback if required
                if (obj.callback) adapter.sendTo(obj.from, obj.command, 'Message received', obj.callback);
            }
        }
    });

    // is called when databases are connected and adapter received configuration.
    // start here!
    adapter.on('ready', function () {
        main();
    });

    // is called when adapter shuts down - callback has to be called under any circumstances!
    adapter.on('unload', function (callback) {
        try {
            if (actionTimeOut) clearTimeout(actionTimeOut);
            if (sleepTimeOut) clearTimeout(sleepTimeOut);
            if (timer) clearInterval(timer);
            if (cbSet) {
                hostCb = false;
                removeCallback(callbackId);
            }
            adapter.log.info('cleaned everything up...');
                callback();
        } catch (e) {
            callback();
        }
    });

    // is called if a subscribed object changes
    adapter.on('objectChange', function (id, obj) {
        // Warning, obj can be null if it was deleted
        adapter.log.debug(`objectChange ${id} ${JSON.stringify(obj)}`);
    });

    // is called if a subscribed state changes
    adapter.on('stateChange', function (id, state) {
        let path = id.split('.',5);
        let nukiId = path[2];
        let actionState = path[4];

        // Warning, state can be null if it was deleted
        adapter.log.debug(`stateChange ${id} ${JSON.stringify(state)}`);

        // you can use the ack flag to detect if it is status (true) or command (false)
        if (state && !state.ack) {
            if (actionState == 'action') {
                setLockAction(nukiId, state.val);
            } else {
                if (state.val == false) {
                    if (actionState == 'lockAction') {
                        setLockAction(nukiId, '2');
                    } else if (actionState == 'rtoAction') {
                        setLockAction(nukiId, '2');
                    }
                } else {
                    switch (actionState) {
                        case 'lockAction':
                            // fall through
                        case 'rtoAction':
                            setLockAction(nukiId, '1');
                            break;
                        case 'openAction':
                            setLockAction(nukiId, '3');
                            break;
                        case 'unlockLocknGoAction':
                            // fall through
                        case 'cmActiveAction':
                            setLockAction(nukiId, '4');
                            break;
                        case 'openLocknGoAction':
                            // fall through
                        case 'cmDeactiveAction':
                            setLockAction(nukiId, '5');
                            break;
                        default:
                            adapter.log.warn(`unrecognized actionState (${actionState})`);
                            break;
                    }
                }
            }
        }
    });

    return adapter;
};

function initBridgeStates(_name, _token) {
    let timeStamp = new Date().toISOString().substr(0,19) + '+00:00';

    adapter.setObjectNotExists(`${bridgeId}`, {
        type: 'device',
        common: {
            name: _name
        },
        native: {}
    });

    adapter.setObjectNotExists(`${bridgeId}.info`, {
        type: 'channel',
        common: {
            name: 'Info'
        },
        native: {}
    });

    adapter.setObjectNotExists(`${bridgeId}.info.bridgeIp`, {
        type: 'state',
        common: {
            name: 'IP-Adresse',
            type: 'string',
            write: false,
            role: 'info.ip',
            def: bridgeIp
        },
        native: {}
    });

    adapter.setObjectNotExists(`${bridgeId}.info.bridgePort`, {
        type: 'state',
        common: {
            name: 'Port',
            type: 'string',
            write: false,
            role: 'info.port',
            def: bridgePort
        },
        native: {}
    });

    adapter.setObjectNotExists(`${bridgeId}.info.bridgeToken`, {
        type: 'state',
        common: {
            name: 'Token',
            type: 'string',
            write: false,
            role: 'text',
            def: _token
        },
        native: {}
    });

    adapter.setObjectNotExists(`${bridgeId}.info.bridgeType`, {
        type: 'state',
        common: {
            name: 'Typ',
            type: 'number',
            write: false,
            states: {
                1: 'Hardware Bridge',
                2: 'Software Bridge',
            },
            role: 'value',
            def: bridgeType
        },
        native: {}
    });

    if (bridgeType == 1) {
        adapter.setObjectNotExists(`${bridgeId}.info.hardwareId`, {
            type: 'state',
            common: {
                name: 'HardwareID',
                type: 'string',
                write: false,
                role: 'text',
                def: bridgeHwId
            },
            native: {}
        });
        
        adapter.setObjectNotExists(`${bridgeId}.info.firmwareVersion`, {
            type: 'state',
            common: {
                name: 'Firmware',
                type: 'string',
                write: false,
                role: 'text'
            },
            native: {}
        });

        adapter.setObjectNotExists(`${bridgeId}.info.wifiFirmwareVersion`, {
            type: 'state',
            common: {
                name: 'WiFi Firmware',
                type: 'string',
                write: false,
                role: 'text'
            },
            native: {}
        });
    } else {
        adapter.setObjectNotExists(`${bridgeId}.info.appVersion`, {
            type: 'state',
            common: {
                name: 'App Version',
                type: 'string',
                write: false,
                role: 'text'
            },
            native: {}
        });
    }
    
    adapter.setObjectNotExists(`${bridgeId}.info.timestamp`, {
        type: 'state',
        common: {
            name: 'Zuletzt aktualisiert',
            type: 'string',
            write: false,
            role: 'date'
        },
        native: {}
    });

    setBridgeState(timeStamp);
}

function initNukiDeviceStates(_obj) {
    let nukiState = _obj.lastKnownState;
    let deviceType = 1;
    let firmwareVersion = '';
    
    // device
    adapter.setObjectNotExists(`${_obj.nukiId}`, {
        type: 'device',
        common: {
            name: _obj.name
        },
        native: {}
    });

    // device info
    adapter.setObjectNotExists(`${_obj.nukiId}.info`, {
        type: 'channel',
        common: {
            name: 'Information'
        },
        native: {}
    });

    // device states
    adapter.setObjectNotExists(`${_obj.nukiId}.states`, {
        type: 'channel',
        common: {
            name: 'Status'
        },
        native: {}
    });

    if (_obj.hasOwnProperty('deviceType')) {
        deviceType = _obj.deviceType;
    } else {
        deviceType = get_devicetype_by_statename(nukiState.stateName)
    }
    
    switch(deviceType) {
        case 0:
            initNukiLockStates(_obj.nukiId);
            break;
        case 2:
            initNukiOpenerStates(_obj.nukiId);
            break;
        case 3:
            initNukiLockStates(_obj.nukiId);
            break;
        case 4:
            initNukiLockStates(_obj.nukiId);
            break;
        default:
            adapter.log.error(`Unknown device type (${deviceType}). Setting minimal states.`);
            deviceType = 1; 
            break;
    }

    adapter.setObjectNotExists(`${_obj.nukiId}.info.deviceType`, {
        type: 'state',
        common: {
            name: 'Typ',
            type: 'number',
            write: false,
            states: {
                0: 'Nuki Smart Lock 1.0/2.0',
                1: 'unknown device',
                2: 'Nuki Opener',
                3: 'Nuki Smart Door',
                4: 'Nuki Smart Lock 3.0 (Pro)',
            },
            def: deviceType,
            role: 'value'
        },
        native: {}
    });

    if (_obj.hasOwnProperty('firmwareVersion')) {
        firmwareVersion = _obj.firmwareVersion
        adapter.setObjectNotExists(`${_obj.nukiId}.info.firmwareVersion`, {
            type: 'state',
            common: {
                name: 'Firmware',
                type: 'string',
                write: false,
                role: 'text',
                def: firmwareVersion
            },
            native: {}
        });
    }

    if (nukiState.hasOwnProperty('ringactionState')) {
        adapter.setObjectNotExists(`${_obj.nukiId}.states.ringactionState`, {
            type: 'state',
            common: {
                name: 'Klingel betätigt',
                type: 'boolean',
                write: false,
                role: 'indicator'   
            },
            native: {}
        });

        // listen to changes
        adapter.subscribeStates(`${_obj.nukiId}.states.ringactionState`);
    }

    if (nukiState.hasOwnProperty('ringactionTimestamp')) {
        adapter.setObjectNotExists(`${_obj.nukiId}.states.ringactionTimestamp`, {
            type: 'state',
            common: {
                name: 'Letzte Klingelbetätigung',
                type: 'string',
                write: false,
                role: 'date'
            },
            native: {}
        });
    }

    adapter.setObjectNotExists(`${_obj.nukiId}.info.batteryCritical`, {
        type: 'state',
        common: {
            name: 'Batterie schwach',
            type: 'boolean',
            write: false,
            role: 'indicator.lowbat'
        },
        native: {}
    });

    // listen to changes
    adapter.subscribeStates(`${_obj.nukiId}.info.batteryCritical`);

    if (nukiState.hasOwnProperty('batteryCharging')) {
        adapter.setObjectNotExists(`${_obj.nukiId}.info.batteryCharging`, {
            type: 'state',
            common: {
                name: 'Batterie lädt',
                type: 'boolean',
                write: false,
                role: 'indicator.maintenance.lowbat'
            },
            native: {}
        });

        // listen to changes
        adapter.subscribeStates(`${_obj.nukiId}.info.batteryCharging`);
    }

    if (nukiState.hasOwnProperty('batteryChargeState')) {
        adapter.setObjectNotExists(`${_obj.nukiId}.info.batteryChargeState`, {
            type: 'state',
            common: {
                name: 'Ladezustand der Batterie',
                type: 'number',
                write: false,
                role: 'value.battery'
            },
            native: {}
        });

        // listen to changes
        adapter.subscribeStates(`${_obj.nukiId}.info.batteryChargeState`);
    }

    if (nukiState.hasOwnProperty('keypadBatteryCritical')) {
        adapter.setObjectNotExists(`${_obj.nukiId}.info.keypadBatteryCritical`, {
            type: 'state',
            common: {
                name: 'KeyPad-Batterie schwach',
                type: 'boolean',
                write: false,
                role: 'indicator.lowbat'
            },
            native: {}
        });

        // listen to changes
        adapter.subscribeStates(`${_obj.nukiId}.info.keypadBatteryCritical`);
    }
    
    adapter.setObjectNotExists(`${_obj.nukiId}.states.timestamp`, {
        type: 'state',
        common: {
            name: 'Zuletzt aktualisiert',
            type: 'string',
            write: false,
            role: 'date'
        },
        native: {}
    });

    // set states
    setLockState(_obj.nukiId, deviceType, nukiState, firmwareVersion);
}

function initNukiLockStates(_nukiId) {
    let doorsensorState = 4;

    adapter.setObjectNotExists(`${_nukiId}.info.mode`, {
        type: 'state',
        common: {
            name: 'Modus',
            type: 'number',
            write: false,
            states: {
                2: 'door mode',
                3: '-',
            },
            role: 'value'
        },
        native: {}
    });

    adapter.setObjectNotExists(`${_nukiId}.states.lockState`, {
        type: 'state',
        common: {
            name: 'Nuki aufgeschlossen',
            type: 'boolean',
            write: false,
            role: 'sensor.lock'   
        },
        native: {}
    });

    adapter.setObjectNotExists(`${_nukiId}.states.state`, {
        type: 'state',
        common: {
            name: 'Status',
            type: 'number',
            write: false,
            states: {
                0: 'uncalibrated',
                1: 'locked',
                2: 'unlocking',
                3: 'unlocked',
                4: 'locking',
                5: 'unlatched',
                6: 'unlocked (lock n go)',
                7: 'unlatching',
                253: '-',
                254: 'motor blocked',
                255: 'undefined',
            },
            role: 'value'
        },
        native: {}
    });

    adapter.setObjectNotExists(`${_nukiId}.states.doorState`, {
        type: 'state',
        common: {
            name: 'Türsensor',
            type: 'number',
            write: false,
            states: {
                1: 'deactivated',
                2: 'door closed',
                3: 'door opened',
                4: 'door state unknown',
                5: 'calibrating',
            },
            role: 'value',
            def: doorsensorState
        },
        native: {}
    });

    // device actions
    adapter.setObjectNotExists(`${_nukiId}.actions`, {
        type: 'channel',
        common: {
            name: 'Aktionen'
        },
        native: {}
    });

    adapter.setObjectNotExists(`${_nukiId}.actions.action`, {
        type: 'state',
        common: {
            name: 'Aktion',
            type: 'number',
            states: {
                0: '',
                1: 'unlock',
                2: 'lock',
                3: 'unlatch',
                4: 'lock‘n’go',
                5: 'lock‘n’go with unlatch',
            },
            role: 'value'
        },
        native: {}
    });

    adapter.setObjectNotExists(`${_nukiId}.actions.lockAction`, {
        type: 'state',
        common: {
            name: 'Tür auf-/abschließen',
            type: 'boolean',
            write: true,
            role: 'switch.lock.door'
        },
        native: {}
    });

    adapter.setObjectNotExists(`${_nukiId}.actions.openAction`, {
        type: 'state', 
        common: {
            name:  'Tür öffnen',
            type:  'boolean',
            write: true,
            read:  false,
            role:  'button.open.door'
        },
        native: {}
    });

    adapter.setObjectNotExists(`${_nukiId}.actions.unlockLocknGoAction`, {
        type: 'state', 
        common: {
            name:  'Tür aufschließen (lock‘n’go)',
            type:  'boolean',
            write: true,
            read:  false,
            role:  'button.open.door'
        },
        native: {}
    });

    adapter.setObjectNotExists(`${_nukiId}.actions.openLocknGoAction`, {
        type: 'state', 
        common: {
            name:  'Tür öffnen (lock‘n’go)',
            type:  'boolean',
            write: true,
            read:  false,
            role:  'button.open.door'
        },
        native: {}
    });

    // listen to changes
    adapter.subscribeStates(`${_nukiId}.actions.*Action`);
    adapter.subscribeStates(`${_nukiId}.actions.action`);
}

function initNukiOpenerStates(_nukiId) {

    adapter.setObjectNotExists(`${_nukiId}.info.mode`, {
        type: 'state',
        common: {
            name: 'Modus',
            type: 'number',
            write: false,
            states: {
                2: 'door mode',
                3: 'continuous mode',
            },
            role: 'value'
        },
        native: {}
    });

    adapter.setObjectNotExists(`${_nukiId}.states.lockState`, {
        type: 'state',
        common: {
            name: 'Ring to Open aktiv',
            type: 'boolean',
            write: false,
            role: 'indicator'   
        },
        native: {}
    });
    
    adapter.setObjectNotExists(`${_nukiId}.states.state`, {
        type: 'state',
        common: {
            name: 'Status',
            type: 'number',
            write: false,
            states: {
                0: 'untrained',
                1: 'online',
                2: '-',
                3: 'rto active',
                4: '-',
                5: 'open',
                6: '-',
                7: 'opening',
                253: 'boot run',
                254: '-',
                255: 'undefined',
            },
            role: 'value'
        },
        native: {}
    });
    
    // device actions
    adapter.setObjectNotExists(`${_nukiId}.actions`, {
        type: 'channel',
        common: {
            name: 'Aktionen'
        },
        native: {}
    });

    adapter.setObjectNotExists(`${_nukiId}.actions.action`, {
        type: 'state',
        common: {
            name: 'Aktion',
            type: 'number',
            states: {
                0: '',
                1: 'activate rto',
                2: 'deactivate rto',
                3: 'electric strike actuation',
                4: 'activate continuous mode',
                5: 'deactivate continuous mode',
            },
            role: 'value'
        },
        native: {}
    });

    adapter.setObjectNotExists(`${_nukiId}.actions.rtoAction`, {
        type: 'state',
        common: {
            name: 'Ring to Open de-/aktivieren',
            type: 'boolean',
            write: true,
            role: 'switch.lock.door'
        },
        native: {}
    });

    adapter.setObjectNotExists(`${_nukiId}.actions.openAction`, {
        type: 'state', 
        common: {
            name:  'öffnen',
            type:  'boolean',
            write: true,
            read:  false,
            role:  'button.open.door'
        },
        native: {}
    });

    adapter.setObjectNotExists(`${_nukiId}.actions.cmActiveAction`, {
        type: 'state', 
        common: {
            name:  'Dauermodus einschalten',
            type:  'boolean',
            write: true,
            read:  false,
            role:  'button.open.door'
        },
        native: {}
    });

    adapter.setObjectNotExists(`${_nukiId}.actions.cmDeactiveAction`, {
        type: 'state', 
        common: {
            name:  'Dauermodus ausschalten',
            type:  'boolean',
            write: true,
            read:  false,
            role:  'button.open.door'
        },
        native: {}
    });

    // listen to changes
    adapter.subscribeStates(`${_nukiId}.actions.*Action`);
    adapter.subscribeStates(`${_nukiId}.actions.action`);
}

function setBridgeState(_timestamp) {
    if (bridgeType == 1) {
        // set firmware version
        adapter.setState(`${bridgeId}.info.firmwareVersion`, {val: bridgeFwVer, ack: true});
        // set WiFi firmware version
        adapter.setState(`${bridgeId}.info.wifiFirmwareVersion`, {val: bridgeWifiFwVer, ack: true});
    } else if (bridgeType == 2) {
        // set app version
        adapter.setState(`${bridgeId}.info.appVersion`, {val: bridgeAppVer, ack: true});
    }

    // set timestamp
    adapter.setState(`${bridgeId}.info.timestamp`, {val: _timestamp, ack: true});
}

function setLockState(_nukiId, _deviceType, _nukiState, _firmWare) {
    let timeStamp = null;

    if (_nukiState == null) {
        // no state set
        return;
    }
 
    // set device type
    adapter.setState(`${_nukiId}.info.deviceType`, {val: _deviceType, ack: true});
    // set battery status
    adapter.setState(`${_nukiId}.info.batteryCritical`, {val: _nukiState.batteryCritical, ack: true});

    if (_nukiState.hasOwnProperty('batteryCharging')) {
        if (_nukiState.batteryCharging != null) {
            // set battery charge status
            adapter.setState(`${_nukiId}.info.batteryCharging`, {val: _nukiState.batteryCharging, ack: true});
        }
    }

    if (_nukiState.hasOwnProperty('batteryChargeState')) {
        if (_nukiState.batteryChargeState != null) {
            // set battery charge level
            adapter.setState(`${_nukiId}.info.batteryChargeState`, {val: _nukiState.batteryChargeState, ack: true});
        }
    }

    if (_nukiState.hasOwnProperty('keypadBatteryCritical')) {
        if (_nukiState.keypadBatteryCritical != null) {
            // set keypad battery status
            adapter.setState(`${_nukiId}.info.keypadBatteryCritical`, {val: _nukiState.keypadBatteryCritical, ack: true});
        }
    }

    // set timestamp
    if (_nukiState.hasOwnProperty('timestamp')) {
        timeStamp =  _nukiState.timestamp;
    } else {
        timeStamp = new Date().toISOString().substr(0,19) + '+00:00';
    }
    adapter.setState(`${_nukiId}.states.timestamp`, {val: timeStamp, ack: true});

    // lock or opener?
    if (_deviceType == 0 || _deviceType == 3 || _deviceType == 4) {
        // set lock action and state
        switch(_nukiState.state) {
            case 1:
                // fall through
            case 4:
                adapter.setState(`${_nukiId}.states.lockState`, {val: false, ack: true});
                adapter.setState(`${_nukiId}.actions.lockAction`, {val: false, ack: true}); 
                break;
            case 2:
                // fall through
            case 3:
                // fall through
            case 5:
                // fall through
            case 6:
                // fall through
            case 7:
                adapter.setState(`${_nukiId}.states.lockState`, {val: true, ack: true});
                adapter.setState(`${_nukiId}.actions.lockAction`, {val: true, ack: true});
                break;
            default:
                adapter.setState(`${_nukiId}.states.lockState`, {val: true, ack: true});
                adapter.setState(`${_nukiId}.actions.lockAction`, {val: true, ack: true});
                break;
        }   
    } else if (_deviceType == 2) {
        // set opener action and state
        switch(_nukiState.state) {
            case 1:
                // fall through
            case 4:
                adapter.setState(`${_nukiId}.states.lockState`, {val: false, ack: true});
                adapter.setState(`${_nukiId}.actions.rtoAction`, {val: false, ack: true});
                break;
            case 2:
                // fall through
            case 3:
                // fall through
            case 5:
                // fall through
            case 6:
                // fall through
            case 7:
                adapter.setState(`${_nukiId}.states.lockState`, {val: true, ack: true});
                adapter.setState(`${_nukiId}.actions.rtoAction`, {val: true, ack: true});
                break;
            default:
                adapter.setState(`${_nukiId}.states.lockState`, {val: true, ack: true});
                adapter.setState(`${_nukiId}.actions.rtoAction`, {val: true, ack: true});
                break;
        }   
    } else {
        // unknown device
        return;
    }
    
    // reset action state after delay
    actionTimeOut = setTimeout(function() {
        adapter.setState(`${_nukiId}.actions.action`, {val: 0, ack: true});
    }, timeOut);

    // set mode
    let mode = 0;
    mode = _nukiState.mode;
    adapter.setState(`${_nukiId}.info.mode`, {val: mode, ack: true});
    // set status
    let state = 0;
    state = _nukiState.state;
    adapter.setState(`${_nukiId}.states.state`, {val: state, ack: true});

    if (_nukiState.hasOwnProperty('ringactionState') && _nukiState.ringactionState != null) {
        // set doorsensor status
        adapter.setState(`${_nukiId}.states.ringactionState`, {val: _nukiState.ringactionState, ack: true});
    }

    if (_nukiState.hasOwnProperty('ringactionTimestamp') && _nukiState.ringactionTimestamp != '') {
        // set doorsensor status
        adapter.setState(`${_nukiId}.states.ringactionTimestamp`, {val: _nukiState.ringactionTimestamp, ack: true});
    }

    if (_nukiState.hasOwnProperty('doorsensorState')) {
        // set doorsensor status
        let doorState = 0;
        doorState = _nukiState.doorsensorState;
        adapter.setState(`${_nukiId}.states.doorState`, {val: doorState, ack: true});
    }

    if (_firmWare != null && _firmWare != '') {
        // set firmware version
        adapter.setState(`${_nukiId}.info.firmwareVersion`, {val: _firmWare, ack: true});
    }
}

function updateAllLockStates(_content, _init) {
    let obj             = null;
    let deviceType      = 0;
    let nukilock        = 0;
    
    if (_content == null) {
        adapter.log.error('no content');
        return;
    }
    
    for (nukilock in _content) {
        obj = _content[nukilock];
        if (obj) {
            if (_init) {
                adapter.log.debug(`found Nuki device: ${obj.nukiId}`);
                initNukiDeviceStates(obj);
            } else {
                adapter.log.debug(`updating Nuki device: ${obj.nukiId}`);
                if (obj.hasOwnProperty('deviceType')) {
                    deviceType = obj.deviceType;
                } else {
                    deviceType = 0;
                }

                if (obj.hasOwnProperty('firmwareVersion')) {
                    setLockState(obj.nukiId, deviceType, obj.lastKnownState, obj.firmwareVersion);
                } else {
                    setLockState(obj.nukiId, deviceType, obj.lastKnownState);
                }
            }
        }
    }
}

function getLockState(_nukiId, _forced) {

    if (_forced) { 
        // retrieve states directly from the device
        adapter.getState(`${_nukiId}.info.deviceType`, function (err, state) {
            let deviceType = 0;
            let lockStateUrl = null;
            let timeStamp = '';

            deviceType = state.val;
    
            if (err) {
                adapter.log.error(err);
                return;
            }
        
            if (!deviceType || deviceType == 1) {
                lockStateUrl = `http://${bridgeIp}:${bridgePort}/lockState?nukiId=${_nukiId}&${get_token()}`;
            } else {
                lockStateUrl = `http://${bridgeIp}:${bridgePort}/lockState?nukiId=${_nukiId}&deviceType=${deviceType}&${get_token()}`;
            }

            request(
                {
                    url: lockStateUrl,
                    json: true
                },  
                function (error, response, content) {
                    let doorsensorState = 4;
                    let doorsensorStateName = 'door state unknown';
                    let keypadBatteryCritical = null;
                    let ringactionState = null;
                    let ringactionTimestamp = '';

                    adapter.log.debug(`state requested: ${lockStateUrl}`);
                    
                    if (error) {
                        adapter.log.error(error);
                        return;
                    }

                    if (response.statusCode != 200) {
                        switch (response.statusCode) {
                            case 401:
                                adapter.log.error('Given token is invalid.');
                                break;
                        
                            case 404:
                                adapter.log.error('Nuki device is unknown.');
                                break;
                    
                            case 503:
                                adapter.log.error('Nuki device is offline.');
                                break;
                            
                            default:
                                adapter.log.error(`HTTP-response: ${response.statusCode}`);
                                break;
                        }
                        return;
                    }

                    if (content && content.hasOwnProperty('success')) {
                        if (content.success) {
                            timeStamp = new Date().toISOString().substr(0,19) + '+00:00' ;

                            if (req.body.hasOwnProperty('keypadBatteryCritical')) {
                                keypadBatteryCritical = req.body.keypadBatteryCritical;
                            }

                            if (content.hasOwnProperty("doorsensorState")){
                                doorsensorState = content.doorsensorState;
                                doorsensorStateName = content.doorsensorStateName;
                            }

                            if (req.body.hasOwnProperty('ringactionState')) {
                                ringactionState = req.body.ringactionState;
                                ringactionTimestamp = req.body.ringactionTimestamp;
                            }

                            let nukiState = { "mode": mode, "state": state, "stateName": stateName, "batteryCritical": batteryCritical, 
                                    "keypadBatteryCritical": keypadBatteryCritical, "doorsensorState": doorsensorState, 
                                    "doorsensorStateName": doorsensorStateName, "timestamp": timeStamp, "ringactionState": ringactionState, 
                                    "ringactionTimestamp": ringactionTimestamp };
                            setLockState(_nukiId, deviceType, nukiState);
                        } else {
                            adapter.log.warn('State has not been retrieved. Check if device is connected to bridge and try again.');
                        }
                    } else {
                        adapter.log.warn('Response has no valid content. Check IP address and try again.');
                    }
                }
            )  
        });
    } else {
        // get all Nuki devices on bridge
        getLockList(false);
    }
}

function setLockAction(_nukiId, _action) {

    adapter.getState(`${_nukiId}.info.deviceType`, function (err, state) {
        let deviceType = 0;
        let lockActionUrl = null;

        deviceType = state.val;

        if (err) {
            adapter.log.error(err);
            return;
        }
    
        adapter.log.debug(`Setting lock action ${_action} for NukiID ${_nukiId} (device type ${deviceType}).`);
        if (!deviceType || deviceType == 1) {
            lockActionUrl = `http://${bridgeIp}:${bridgePort}/lockAction?nukiId=${_nukiId}&action=${_action}&${get_token()}`;
        } else {
            lockActionUrl = `http://${bridgeIp}:${bridgePort}/lockAction?nukiId=${_nukiId}&deviceType=${deviceType}&action=${_action}&${get_token()}`;
        }

        request(
            {
                url: lockActionUrl,
                json: true
            },  
            function (error, response, content) {
                adapter.log.debug(`action requested: ${lockActionUrl}`);

                if (error) {
                    adapter.log.error(error);
                    return;
                }
    
                if (response.statusCode != 200) {
                    switch (response.statusCode) {
                        case 400:
                            adapter.log.error('Given action is invalid.');
                            break;
                    
                        case 401:
                            adapter.log.error('Given token is invalid.');
                            break;
                    
                        case 404:
                            adapter.log.error('Nuki device is unknown.');
                            break;
                        
                        case 503:
                            adapter.log.error('Nuki device is offline.');
                            break;
                            
                        default:
                            adapter.log.error(`HTTP-response: ${response.statusCode}`);
                            break;
                    }
                    return;
                }
    
                if (content && content.hasOwnProperty('success')) {
                    if (!content.success) {
                        adapter.log.warn(`action ${_action} not successfully set!`);
                    } else {
                        adapter.log.info(`action ${_action} set successfully`);   
                        if (hostCb == false) {       
                            getLockState(_nukiId, false);
                        } else {

                        }
                    }
                } else {
                    adapter.log.warn('Response has no valid content. Check IP address and try again.');
                }
            }
        )
    });
}

function getBridgeList() {
    let bridgeListUrl = 'https://api.nuki.io/discover/bridges';
    let obj = null;

    request(
        {
            url: bridgeListUrl,
            json: true
        },  
        function (error, response, content) {
            adapter.log.debug(`Bridge list requested: ${bridgeListUrl}`);

            if (error) {
                adapter.log.error(error);
                return;
            }

            if (response.statusCode != 200) {
                adapter.log.error(`HTTP-response: ${response.statusCode}`);
                return;
            }

            if (!content || !content.hasOwnProperty('errorCode')) {
                adapter.log.warn('Response has no valid content. Check if bridge ist pluged in and active and try again.');
                return;
            }

            if (content.errorCode != 0) {
                adapter.log.warn('Bridge respose has not been retrieved. Check if bridge ist pluged in and active and try again.');
                return;
            }

            for (let bridge in content.bridges) {
                obj = content.bridges[bridge];
                if (!obj) {
                    adapter.log.warn('Bridge respose has not been retrieved. Check if bridge ist plugged in and active and try again.');
                    return;
                }

                if (obj.hasOwnProperty('ip')) {
                    if (obj.ip == bridgeIp) {
                        // found bridge
                        bridgeId   = obj.bridgeId;
                        bridgeType = 1;
                        if (obj.port == bridgePort) {
                            // correct port
                            adapter.log.info(`found hardware bridge: ${bridgeId} (IP: ${bridgeIp}; Port: ${bridgePort})`);
                        } else {
                            // different port
                            adapter.log.warn(`found hardware bridge (ID: ${bridgeId}; IP: ${obj.ip}) has different port than specified! (specified: ${bridgePort}; actual: ${obj.port}). Please specify correct port of bridge.`);
                        }
                    } else if (obj.ip == '0.0.0.0' || obj.ip == '') {
                        adapter.log.warn(`bridgeID ${obj.bridgeId}: no auto discovery possible. Has the HTTP API been activated and the token been set?`);
                    } else {
                        adapter.log.info(`found another hardware bridge: ${obj.bridgeId} (IP: ${obj.ip}; Port: ${obj.port})`);
                    }
                } else {
                    // software bridge: doesn't come with IP
                    if (bridgeId == '' || bridgeId == null) {
                        bridgeId   = obj.bridgeId;
                        bridgeType = 2;
                    }
                    adapter.log.info(`found software bridge: ${obj.bridgeId}`);
                }
            }

            if (bridgeId == '' || bridgeId == null) {
                adapter.log.error('no bridge has been found');
                return;
            }
        }
    )
}

function getBridgeInfo(_init, _encrypt) {
    let bridgeInfoUrl = `http://${bridgeIp}:${bridgePort}/info?${get_token(_encrypt)}`;

    if (adapter.config.bridge_ip == '' || adapter.config.bridge_port == '') {
        adapter.log.warn('please specify IP and port of bridge');
        return;
    }

    request(
        {
            url: bridgeInfoUrl,
            json: true
        },  
        function (error, response, content) {
            adapter.log.info(`Bridge Info requested: ${bridgeInfoUrl}`);

            if (error) {
                adapter.log.error(error);
                return;
            }

            if (response.statusCode != 200) {
                switch (response.statusCode) {
                    case 401:
                        adapter.log.error('Given token is invalid.');
                        break;

                    default:
                        adapter.log.error(`HTTP-response: ${response.statusCode}`);
                        break;
                }
                return;
            }

            if (content) {
                let ids = content.ids;
                let versions = content.versions;
                
                bridgeType = content.bridgeType;
                bridgeId = ids.serverId;
                if (bridgeType == 1) {
                    bridgeHwId = ids.hardwareId.toString();
                    bridgeFwVer = versions.firmwareVersion;
                    bridgeWifiFwVer = versions.wifiFirmwareVersion;
                } else {
                    bridgeAppVer = versions.appVersion
                }
            } else {
                adapter.log.error('Unable access the bridge with specified IP address and port.');
                
                // Nuki bridge discovery
                getBridgeList();

                return;
            }

            if (_init) {
                initBridgeStates(bridgeName, bridgeToken);
            } else {
                setBridgeState(content.currentTime);
            }
        }
    )
}

async function getLockList(_init) {
    // delay before next request
    await sleep(timeOut);
     
    // get Nuki bridge info
    getBridgeInfo(_init, 'X');

    if (!bridgeFwVer) {
        // delay before next request
        await sleep(timeOut);
        // get Nuki bridge info
        getBridgeInfo(_init, '');
    }

    // delay before next request
    await sleep(timeOut);
     
    let lockListUrl = `http://${bridgeIp}:${bridgePort}/list?${get_token()}`;
   
    request(
        {
            url: lockListUrl,
            json: true
        },  
        function (error, response, content) {
            adapter.log.info(`Lock list requested: ${lockListUrl}`);

            if (error) {
                adapter.log.error(error);
                return;
            }

            if (response.statusCode != 200) {
                switch (response.statusCode) {
                    case 401:
                        adapter.log.error('Given token is invalid.');
                        break;
                
                    default:
                        adapter.log.error(`HTTP-response: ${response.statusCode}`);
                        break;
                }
                return;
            }

            if (content) {
                updateAllLockStates(content, _init);
            } else {
                adapter.log.warn('Response has no valid content. Check IP address and port and try again.');
            }
        }
    )

    if (_init) {
        // delay before next request
        await sleep(timeOut);

        // check for callbacks on Nuki bridge
        checkCallback(hostCb);
    }
}

function initServer(_ip, _port) {
    app.use(bodyParser.json()); // support json encoded bodies
    app.use(bodyParser.urlencoded({ extended: true })); // support encoded bodies

    // routes will go here
    app.get('/api/:key', function(req, res) {
        res.send(`Hello ${req.params.key} ;-)`);
    });

    // POST parameters sent with 
    app.post(`/api/nuki.${adapter.instance}`, function(req, res) {
        let nukiId = req.body.nukiId;
        let deviceType = 0;
        let mode = '2';
        let state = req.body.state;
        let stateName = req.body.stateName;
        let batteryCritical = req.body.batteryCritical;
        let keypadBatteryCritical = null;
        let timeStamp = new Date().toISOString().substr(0,19) + '+00:00';
        let doorsensorState = 4;
        let doorsensorStateName = 'door state unknown';
        let ringactionState = null;
        let ringactionTimestamp = '';

        if (req.body.hasOwnProperty('keypadBatteryCritical')) {
            keypadBatteryCritical = req.body.keypadBatteryCritical;
        }

        if (req.body.hasOwnProperty('deviceType')) {
            deviceType = req.body.deviceType
        }
        
        if (req.body.hasOwnProperty('mode')) {
            mode = req.body.mode;
        }

        if (req.body.hasOwnProperty('doorsensorState')) {
            doorsensorState = req.body.doorsensorState;
            doorsensorStateName = req.body.doorsensorStateName;
        }

        if (req.body.hasOwnProperty('ringactionState')) {
            ringactionState = req.body.ringactionState;
            ringactionTimestamp = req.body.ringactionTimestamp;
        }

        let nukiState = { "mode": mode, "state": state, "stateName": stateName, "batteryCritical": batteryCritical, 
                "keypadBatteryCritical": keypadBatteryCritical, "doorsensorState": doorsensorState, 
                "doorsensorStateName": doorsensorStateName, "timestamp": timeStamp, "ringactionState": ringactionState, 
                "ringactionTimestamp": ringactionTimestamp };

        try {
            adapter.log.info(`status change received for NukiID ${nukiId}: ${nukiState.stateName}`);
            adapter.log.info(`battery status received for NukiID ${nukiId}: ${nukiState.batteryCritical}`);
            setLockState(nukiId, deviceType, nukiState);

            res.sendStatus(200);
        } catch (e) {
            res.sendStatus(500);
			adapter.log.warn(e.message);
        }
    });

    // start the server
    app.listen(_port, _ip);
    adapter.log.info(`Server listening to http://${_ip}:${_port}`);
}

function checkCallback(_hostCb) {
    let cbListUrl = `http://${bridgeIp}:${bridgePort}/callback/list?&${get_token()}`;
    let cbUrl = `http://${hostIp}:${hostPort}/api/nuki.${adapter.instance}`;
    let cbExists = false;
    let cbId = null;

    request(
        {
            url: cbListUrl,
            json: true
        },  
        function (error, response, content) {
            adapter.log.debug(`Callback list requested: ${cbListUrl}`);

            if (error) {
                adapter.log.error(error);
                return;
            }

            if (response.statusCode != 200) {
                switch (response.statusCode) {
                    case 401:
                        adapter.log.error('Given token is invalid.');
                        break;
                
                    default:
                        adapter.log.error(`HTTP-response: ${response.statusCode}`);
                        break;
                }
                return;
            }

            if (content && content.hasOwnProperty('callbacks')) {
                for (let row in content.callbacks) {
                    cbId = content.callbacks[row];
                    if (cbId.url == cbUrl) {
                        cbExists = true;
                        if (_hostCb == false) {
                            adapter.log.debug(`Callback should be removed: ${cbUrl}`);
                            removeCallback(cbId.id);
                        }
                    } 
                }
                if (_hostCb == true) {
                    if (cbId) {
                        callbackId = cbId.id;
                    } else {
                        callbackId = '0';
                    }
                    if (cbExists) {
                            cbSet = true;
                            adapter.log.info(`Callback allready set: ${cbUrl}`);
                            initServer(hostIp, hostPort);
                    } else {
                        if (callbackId == '3') {
                            cbSet = false;
                            adapter.log.warn('Too many Callbacks defined (3). First delete at least 1 Callback on your Nuki bridge.');
                        } else {
                            cbSet = true;
                            initServer(hostIp, hostPort);
                            setCallback(cbUrl);
                        }
                    }
                }
            } else {
                adapter.log.warn('Response has no valid content. Check IP address and try again.');
            }
        }
    )
}

async function removeCallback(_id) {
    let callbackRemoveUrl = `http://${bridgeIp}:${bridgePort}/callback/remove?id=${_id}&${get_token()}`;

    if (hostCb == false) {
        // delay before next request
        await sleep(timeOut);

        request(
            {
                url: callbackRemoveUrl,
                json: true
            },  
            function (error, response, content) {
                adapter.log.debug(`Callback removal requested: ${callbackRemoveUrl}`);

                if (error) {
                    adapter.log.error(error);
                    return;
                }
    
                if (response.statusCode != 200) {
                    switch (response.statusCode) {
                        case 400:
                            adapter.log.error('Given url is invalid or too long.');
                            break;
                    
                        case 401:
                            adapter.log.error('Given token is invalid.');
                            break;
                    
                        default:
                            adapter.log.error(`HTTP-response: ${response.statusCode}`);
                            break;
                    }
                    return;
                }
    
                if (content && content.hasOwnProperty('success')) {
                    if (content.success) {
                        cbSet = false;
                        adapter.log.info(`Callback-ID successfully removed: ${_id}`);
                    } else {
                        adapter.log.warn(`Callback-ID could not be removed: ${_id}`);
                        if (content.hasOwnProperty('message')) {
                            adapter.log.warn(content.message);
                        }
                    }
                } else {
                    adapter.log.warn('Response has no valid content. Check IP address and try again.');
                }
            }
        )
    }
}

async function setCallback(_url) {
    let callbackString = _url.replace(':', '%3A');
    callbackString = callbackString.replace('/', '%2F');
    let callbackAddUrl = `http://${bridgeIp}:${bridgePort}/callback/add?url=${callbackString}&${get_token()}`;
    
    if (hostCb == true) {
        // delay before next request
        await sleep(timeOut);

        request(
            {
                url: callbackAddUrl,
                json: true
            },  
            function (error, response, content) {
                adapter.log.debug(`Callback requested: ${callbackAddUrl}`);
                
                if (error) {
                    adapter.log.error(error);
                    return;
                }

                if (response.statusCode != 200) {
                    switch (response.statusCode) {
                        case 400:
                            adapter.log.error('Given url is invalid or too long.');
                            break;
                    
                        case 401:
                            adapter.log.error('Given token is invalid.');
                            break;
                    
                        default:
                            adapter.log.error(`HTTP-response: ${response.statusCode}`);
                            break;
                    }
                    return;
                }

                if (content && content.hasOwnProperty('success')) {
                    if (content.success) {
                        adapter.log.info(`Callback successfully set: ${_url}`);
                    } else {
                        adapter.log.warn(`Callback could not be set: ${_url}`);
                        if (content.hasOwnProperty('message')) {
                            adapter.log.warn(content.message);
                        }
                    }
                } else {
                    adapter.log.warn('Response has no valid content. Check IP address and try again.');
                }
            }
        ) 
    }
}

function get_token(_encrypt) {
    let apendix = '';
    
    if (forcePlainToken != '' || bridgeType != 1) {
        apendix = `token=${bridgeToken}`
    } else {
        if (semver.satisfies(bridgeFwVer, '>=1.22.1 <2.0.0 || >=2.14.0')) {
            adapter.log.debug(`Bridge firmware is: ${bridgeFwVer}. Encrypted token is being be used.`);
            /* (async () => {
                apendix = get_ctoken();
            })(); */
            apendix = get_htoken();
        } else if (bridgeFwVer) {
            adapter.log.debug(`Bridge firmware is: ${bridgeFwVer}. Hashed token is being be used.`);
            apendix = get_htoken();
        } else if (_encrypt == 'X') {
            adapter.log.debug(`Bridge firmware is unknown, yet. Trying encrypted token.`);
            /* (async () => {
                apendix = get_ctoken();
            })(); */
            apendix = get_htoken();
        } else {
            adapter.log.info(`Bridge firmware is unknown, yet. Trying hashed token.`);
            apendix = get_htoken();
        }  
    }

    return apendix;
}

async function get_ctoken() {
    let apendix = '';

    // try {
    //     let ts = `${new Date().toISOString().substring(0, 19)}Z`; // YYY-MM-DDTHH:MM:SSZ
    //     let nonce = new Uint8Array(await nacl.randomBytes(24));
    //     let hash = await crypto.createHash('sha256').update(`${bridgeToken}`).digest('hex');
    //     let session_buffer = buffer.from(hash);
    //     let session_key = new Uint8Array(session_buffer);
    //     let box = await nacl.secretbox(session_key);
    //     let ctoken = await box.encrypt(ts.encode('utf-8'), nonce);
    //     let ctoken_hex = await ctoken.ciphertext.hex();

        // return apendix = `ctoken=${ctoken_hex}&nounce=${nonce}`;
    // } catch (error) {
    //     adapter.log.error(error);
        return apendix = get_htoken();
    // }
}

function get_htoken() {
    let apendix = '';

    let ts = `${new Date().toISOString().substring(0, 19)}Z`; // YYY-MM-DDTHH:MM:SSZ
    let rnr = Math.floor(Math.random() * (65535-0) + 0); // Math.random() * (max - min) + min; // uint16 up to 65535
//    let hash = crypto.createHash('sha256').update(`${ts},${rnr},${bridgeToken}`).digest('hex');
    let hash = crypto.createHash('sha256').update(`${bridgeToken}`).digest('hex');
    let ctoken = xsalsa(rnr, hash);
    
//    apendix = `ts=${ts}&rnr=${rnr}&hash=${hash}`;
    apendix = `ctoken=${ctoken}`;

    return apendix;
}

//function get_ctoken() {
//   let apendix = '';
//
//    let ts = `${new Date().toISOString().substring(0, 19)}Z`; // YYY-MM-DDTHH:MM:SSZ
//    let rnr = Math.floor(Math.random() * (65535-0) + 0); // Math.random() * (max - min) + min; // uint16 up to 65535
//    let ctoken = xsalsa(ts, rnr, ).
//    
//    apendix = `ts=${ts}&rnr=${rnr}&hash=${hash}`;
//
//    return apendix;
//}

function get_devicetype_by_statename(_stateName) {
    let deviceType = 1;
    let openerStateNames = [ 'untrained', 'online', 'rto active', 'open', 'opening', 'boot run'];
    let lockStateNames = [ 'uncalibrated', 'locked', 'unlocking', 'unlocked', 'locking', 'unlatched', 'unlocked (lock ‘n’ go)', 'unlatching', 'motor blocked' ];

    adapter.log.debug(`Searching for sate name ${_stateName}`);
    
    for (let stateName in openerStateNames) {
        if ( _stateName == openerStateNames[stateName] ) {
            deviceType = 2;
        }
    }

    if (deviceType == 1) {
        for (let stateName in lockStateNames) {
            if ( _stateName == lockStateNames[stateName] ) {
                deviceType = 0;
            }
        }
    }

    return deviceType;
}

function sleep(ms) {
    return sleepTimeOut = new Promise(resolve => setTimeout(resolve, ms));
}

function main() {
    bridgeIp = adapter.config.bridge_ip;
    bridgePort = adapter.config.bridge_port;
    bridgeType = adapter.config.bridge_type;
    bridgeToken = adapter.config.token;
    forcePlainToken = adapter.config.fp_token;
    bridgeName = (adapter.config.bridge_name === "") ? bridgeIp.replace(/\./g, '_') : adapter.config.bridge_name.replace(/\./g, '_');
    interval = adapter.config.interval * 60000;
    hostPort = adapter.config.host_port;
    hostCb = adapter.config.host_cb;

    if (bridgeIp != '') {
        // The adapters config (in the instance object everything under the attribute "native") is accessible via
        // adapter.config:
        adapter.log.debug(`config Nuki bridge name: ${bridgeName}`);
        adapter.log.debug(`config IP address: ${bridgeIp}`);
        adapter.log.debug(`config port: ${bridgePort}`);
        adapter.log.debug(`config token: ${bridgeToken}`);

        // get all Nuki devices on bridge
        getLockList(true);

        if (adapter.config.autoupd) {
            adapter.log.debug(`timer set: ${interval} milliseconds`);
            // update all states every x milliseconds
            timer = setInterval(getLockList, interval);
        }
    }
}

// If started as allInOne/compact mode => return function to create instance
if (module && module.parent) {
    module.exports = startAdapter;
    //adapter.log.debug('Adapter started in compact mode');
} else {
    // or start the instance directly
    startAdapter();
    //adapter.log.debug('Adapter started in normal mode');
}

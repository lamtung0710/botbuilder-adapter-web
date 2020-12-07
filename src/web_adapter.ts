/**
 * @module botbuilder-adapter-web
 */
/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { Activity, ActivityTypes, BotAdapter, ConversationReference, TurnContext, ResourceResponse } from 'botbuilder';
import * as Debug from 'debug';
import * as WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import * as _ from 'lodash';
import * as mongoose from 'mongoose';
import MessageWeb from './message-web.model';
const debug = Debug('botkit:web');

const clients = {};
const conversation = {};
const room = {}

/**
 * Connect [Botkit](https://www.npmjs.com/package/botkit) or [BotBuilder](https://www.npmjs.com/package/botbuilder) to the Web.
 * It offers both websocket and webhook capabilities.
 * To use this adapter, you will need a compatible chat client - generate one using the [Botkit yeoman generator](https://npmjs.com/package/generator-botkit),
 * or use [the one included in the project repo here.](https://github.com/howdyai/botkit/tree/master/packages/botbuilder-adapter-web/client)
 */
export class WebAdapter extends BotAdapter {
    /**
     * Name used to register this adapter with Botkit.
     * @ignore
     */
    public name = 'Web Adapter';

    /**
     * The websocket server.
     */
    public wss;

    private socketServerOptions: {
        [key: string]: any;
    };

    /**
     * Create an adapter to handle incoming messages from a websocket and/or webhook and translate them into a standard format for processing by your bot.
     *
     * To use with Botkit:
     * ```javascript
     * const adapter = new WebAdapter();
     * const controller = new Botkit({
     *      adapter: adapter,
     *      // other options
     * });
     * ```
     *
     * To use with BotBuilder:
     * ```javascript
     * const adapter = new WebAdapter();
     * const server = restify.createServer();
     * server.use(restify.plugins.bodyParser());
     * // instead of binding processActivity to the incoming request, pass in turn handler logic to createSocketServer
     * let options = {}; // socket server configuration options
     * adapter.createSocketServer(server, options, async(context) => {
     *  // handle turn here
     * });
     * ```
     *
     * @param socketServerOptions an optional object containing parameters to send to a call to [WebSocket.server](https://github.com/websockets/ws/blob/master/doc/ws.md#new-websocketserveroptions-callback).
     */
    public constructor(socketServerOptions?: { [key: string]: any }) {
        super();
        this.socketServerOptions = socketServerOptions || null;
    }

    /**
     * Botkit-only: Initialization function called automatically when used with Botkit.
     *      * Calls createSocketServer to bind a websocket listener to Botkit's pre-existing webserver.
     * @param botkit
     */
    public init(botkit): void {
        // when the bot is ready, register the webhook subscription with the Webex API
        botkit.ready(() => {
            this.createSocketServer(botkit.http, this.socketServerOptions, botkit.handleTurn.bind(botkit));
        });
        if (process.env.STORE_MESSAGE && process.env.MONGO_URI) {
            mongoose.connect(process.env.MONGO_URI, { useUnifiedTopology: true, useNewUrlParser: true });
            const connection = mongoose.connection;
            connection.once("open", function () {
                console.log("BOTKIT: MongoDB database connection established successfully");
            });
        }
    }
    protected async storageMessage(messageType, messageData, ChannelId, sendBy) {
        if (!process.env.STORE_MESSAGE)
            return
        try {
            let message = new MessageWeb({
                MessageType: messageType,
                Message: messageData,
                ChannelId,
                sendBy
            });
            return await message.save();
        } catch (error) {
            console.log(error);
        }
    }
    private sendMessage(message) {
        try {
            if (conversation[message.user]) {
                for (const property in conversation[message.user]) {
                    const ws = conversation[message.user][property];
                    if (ws && ws.readyState === 1) {
                        try {
                            ws.send(JSON.stringify(message));
                        }
                        catch (err) {
                            console.error(err);
                        }
                    }
                    else {
                        console.error('Could not send message, no open websocket found');
                    }
                }
            }
        } catch (error) {
            console.log('sendMessage', error);
        }

    }
    /**
     * Bind a websocket listener to an existing webserver object.
     * Note: Create the server using Node's http.createServer
     * @param server an http server
     * @param socketOptions additional options passed when creating the websocket server with [WebSocket.server](https://github.com/websockets/ws/blob/master/doc/ws.md#new-websocketserveroptions-callback)
     * @param logic a turn handler function in the form `async(context)=>{ ... }` that will handle the bot's logic.
     */
    public createSocketServer(server, socketOptions: any = {}, logic): void {
        this.wss = new WebSocket.Server({
            server,
            ...socketOptions
        });

        function heartbeat(): void {
            this.isAlive = true;
        }

        this.wss.on('connection', (ws) => {
            ws.isAlive = true;
            ws.socketId = uuidv4();
            ws.room = room;
            ws.on('pong', heartbeat);
            ws.on('message', async (payload) => {
                try {
                    const message = JSON.parse(payload);
                    console.log ('message', message);
                    if (_.get(message, 'type') == 'request') {
                        if (_.get(message, 'value') == 'join-conversation') {
                            if (!conversation[message.channelId]) {
                                conversation[message.channelId] = { [ws.socketId]: ws }
                            }
                            conversation[message.channelId][ws.socketId] = ws;
                            ws.send(JSON.stringify({ type: ActivityTypes.Message, text: 'You are already in the conversation!' }))
                        }
                        if (_.get(message, 'value') == 'message' && message?.data) {
                            const userWs = clients[message.data?.user];
                            if (userWs && userWs.readyState === 1) {
                                try {
                                    const messageData = {
                                        "type": "message",
                                        "bot": true,
                                        "data": {
                                            "Type": message.data.messageType || 'text',
                                            "Text": message.data?.text,
                                            "Buttons": []
                                        },
                                        "eventEmit": "received_message"
                                    };
                                    if (message.data?.text) {
                                        userWs.send(JSON.stringify(messageData));
                                        ws.send(JSON.stringify(messageData))
                                        if (message?.data?.type === ActivityTypes.Message) {
                                            await this.storageMessage(message.data.messageType || 'text', messageData, message.data?.user, message.data?.from);
                                        }
                                    }
                                    if (message.data?.image) {
                                        delete messageData.data.Text;
                                        messageData.data.Type = 'image';
                                        messageData.data['Url'] = message.data?.image
                                        userWs.send(JSON.stringify(messageData));
                                        ws.send(JSON.stringify(messageData))
                                        if (message?.data?.type === ActivityTypes.Message) {
                                            await this.storageMessage(message.data.messageType || 'text', messageData, message.data?.user, message.data?.from);
                                        }
                                    }
                                    if (message.data?.file) {
                                        delete messageData.data.Text;
                                        messageData.data.Type = 'file';
                                        messageData.data['FileName'] = message.data?.fileName || message.data?.file.substring(message.data?.file.lastIndexOf('/')+1);
                                        messageData.data['Url'] = message.data?.file
                                        userWs.send(JSON.stringify(messageData));
                                        ws.send(JSON.stringify(messageData))
                                        if (message?.data?.type === ActivityTypes.Message) {
                                            await this.storageMessage(message.data.messageType || 'text', messageData, message.data?.user, message.data?.from);
                                        }
                                    }

                                }
                                catch (err) {
                                    console.error(err);
                                }
                            }
                            else {
                                console.error('Could not send message, no open websocket found');
                            }
                        }
                    } else if (message.audienceId && message.botId) {
                        // join ws
                        ws.user = message.user;
                        clients[message.user] = ws;
                        // this stuff normally lives inside Botkit.congfigureWebhookEndpoint
                        const activity = {
                            timestamp: new Date(),
                            channelId: 'websocket',
                            conversation: {
                                id: message.user
                            },
                            from: {
                                id: message.user
                            },
                            recipient: {
                                id: 'bot'
                            },
                            channelData: message,
                            text: message.text,
                            type: message.type === 'message' ? ActivityTypes.Message : ActivityTypes.Event
                        };
                        
                        ws.room = { audienceId: message.audienceId , botId: message.botId }
                        // set botkit's event type
                        if (activity.type !== ActivityTypes.Message) {
                            activity.channelData.botkitEventType = message.type;
                        }
                        const context = new TurnContext(this, activity as Activity);
                       
                        //call to send Activities
                        this.runMiddleware(context, logic)
                            .catch((err) => { console.error(err.toString()); });
                        
                        if (conversation[message.user]) {
                            
                            for (const property in conversation[message.user]) {
                                const ws = conversation[message.user][property];
                                if (ws && ws.readyState === 1) {
                                    try {
                                        ws.send(JSON.stringify(message));
                                    }
                                    catch (err) {
                                        console.error(err);
                                    }
                                }
                                else {
                                    console.error('Could not send message, no open websocket found');
                                }
                            }
                        }    
                    } else {
                        // note the websocket connection for this user
                        ws.user = message.user;

                        clients[message.user] = ws;
                        // this stuff normally lives inside Botkit.congfigureWebhookEndpoint
                        const activity = {
                            timestamp: new Date(),
                            channelId: 'websocket',
                            conversation: {
                                id: message.user
                            },
                            from: {
                                id: message.user
                            },
                            recipient: {
                                id: 'bot'
                            },
                            channelData: message,
                            text: message.text,
                            type: message.type === 'message' ? ActivityTypes.Message : ActivityTypes.Event
                        };

                        // set botkit's event type
                        if (activity.type !== ActivityTypes.Message) {
                            activity.channelData.botkitEventType = message.type;
                        }

                        const context = new TurnContext(this, activity as Activity);
                        this.runMiddleware(context, logic)
                            .catch((err) => { console.error(err.toString()); });
                        message.from = message.user;
                        message.recipient = 'bot';
                        // send message from client to admin.
                        console.log('sendMessage222222',message)
                        this.sendMessage(message);
                        // if (message.type === ActivityTypes.Message) {
                        //     await this.storageMessage(message.messageType || 'text', message, message.user, message.from);
                        // }
                    }
                } catch (e) {
                    const alert = [
                        'Error parsing incoming message from websocket.',
                        'Message must be JSON, and should be in the format documented here:',
                        'https://botkit.ai/docs/readme-web.html#message-objects'
                    ];
                    console.error(alert.join('\n'));
                    console.error(e);
                }
            });

            ws.on('error', (err) => console.error('Websocket Error: ', err));

            ws.on('close', function () {
                delete (clients[ws.user]);
            });
        });

        setInterval(() => {
            this.wss.clients.forEach(function each(ws) {
                if (ws.isAlive === false) {
                    return ws.terminate();
                }
                ws.isAlive = false;
                ws.ping('', false, () => {
                    // noop
                });
            });
        }, 30000);
    }

    /**
     * Caste a message to the simple format used by the websocket client
     * @param activity
     * @returns a message ready to send back to the websocket client.
     */
    private activityToMessage(activity: Partial<Activity>): any {
        const message = {
            type: activity.type,
            text: activity.text
        };

        // if channelData is specified, overwrite any fields in message object
        if (activity.channelData) {
            Object.keys(activity.channelData).forEach(function (key) {
                message[key] = activity.channelData[key];
            });
        }

        debug('OUTGOING > ', message);
        return message;
    }

    /**
     * Standard BotBuilder adapter method to send a message from the bot to the messaging API.
     * [BotBuilder reference docs](https://docs.microsoft.com/en-us/javascript/api/botbuilder-core/botadapter?view=botbuilder-ts-latest#sendactivities).
     * @param context A TurnContext representing the current incoming message and environment. (not used)
     * @param activities An array of outgoing activities to be sent back to the messaging API.
     */
    public async sendActivities(context: TurnContext, activities: Partial<Activity>[]): Promise<ResourceResponse[]> {
        const responses = [];
        for (let a = 0; a < activities.length; a++) {
            const activity = activities[a];

            const message = this.activityToMessage(activity);

            const channel = context.activity.channelId;

            if (channel === 'websocket') {
                // If this turn originated with a websocket message, respond via websocket
                const ws = clients[activity.recipient.id];
                if (ws && ws['room']['audienceId'] && ws['room']['botId']) {
                    // multiple client 
                    this.wss.clients.forEach(function each(ws) {
                        if (ws && ws.readyState === 1) {
                            if (JSON.stringify(ws.room) === JSON.stringify({ audienceId: context.activity.channelData.user_login.audienceId , botId: context.activity.channelData.user_login.botId })) {
                                ws.send(JSON.stringify(message))
                            }
                            
                        } else {
                            console.error('Could not send message, no open websocket found');
                        }
                    });
                } else {
                    if (ws && ws.readyState === 1) {
                        try {
                            ws.send(JSON.stringify(message));
                            message.user = activity.recipient.id;
                            message.from = 'bot';
                            message.recipient = message.user;
                            console.log('sendMessage1111111',message)
                            this.sendMessage(message);
                            if (message?.type === ActivityTypes.Message && message.text) {
                                await this.storageMessage(message.messageType || 'text', message, message.user, message.from);
                            }
                        } catch (err) {
                            console.error(err);
                        }
                    } else {
                        console.error('Could not send message, no open websocket found');
                    }
                }
                
            } else if (channel === 'webhook') {
                // if this turn originated with a webhook event, enqueue the response to be sent via the http response
                let outbound = context.turnState.get('httpBody');
                if (!outbound) {
                    outbound = [];
                }
                outbound.push(message);
                context.turnState.set('httpBody', outbound);
            }
        }

        return responses;
    }

    /**
     * Web adapter does not support updateActivity.
     * @ignore
     */
    // eslint-disable-next-line
    public async updateActivity(context: TurnContext, activity: Partial<Activity>): Promise<void> {
        debug('Web adapter does not support updateActivity.');
    }

    /**
     * Web adapter does not support updateActivity.
     * @ignore
     */
    // eslint-disable-next-line
    public async deleteActivity(context: TurnContext, reference: Partial<ConversationReference>): Promise<void> {
        debug('Web adapter does not support deleteActivity.');
    }

    /**
     * Standard BotBuilder adapter method for continuing an existing conversation based on a conversation reference.
     * [BotBuilder reference docs](https://docs.microsoft.com/en-us/javascript/api/botbuilder-core/botadapter?view=botbuilder-ts-latest#continueconversation)
     * @param reference A conversation reference to be applied to future messages.
     * @param logic A bot logic function that will perform continuing action in the form `async(context) => { ... }`
     */
    public async continueConversation(reference: Partial<ConversationReference>, logic: (context: TurnContext) => Promise<void>): Promise<void> {
        const request = TurnContext.applyConversationReference(
            { type: 'event', name: 'continueConversation' },
            reference,
            true
        );
        const context = new TurnContext(this, request);
        return this.runMiddleware(context, logic)
            .catch((err) => { console.error(err.toString()); });
    }

    /**
     * Accept an incoming webhook request and convert it into a TurnContext which can be processed by the bot's logic.
     * @param req A request object from Restify or Express
     * @param res A response object from Restify or Express
     * @param logic A bot logic function in the form `async(context) => { ... }`
     */
    public async processActivity(req, res, logic: (context: TurnContext) => Promise<void>): Promise<void> {
        const message = req.body;

        const activity = {
            timestamp: new Date(),
            channelId: 'webhook',
            conversation: {
                id: message.user
            },
            from: {
                id: message.user
            },
            recipient: {
                id: 'bot'
            },
            channelData: message,
            text: message.text,
            type: message.type === 'message' ? ActivityTypes.Message : ActivityTypes.Event
        };

        // set botkit's event type
        if (activity.type !== ActivityTypes.Message) {
            activity.channelData.botkitEventType = message.type;
        }

        // create a conversation reference
        const context = new TurnContext(this, activity as Activity);

        context.turnState.set('httpStatus', 200);

        await this.runMiddleware(context, logic);

        // send http response back
        res.status(context.turnState.get('httpStatus'));
        if (context.turnState.get('httpBody')) {
            res.json(context.turnState.get('httpBody'));
        } else {
            res.end();
        }
    }

    /**
     * Is given user currently connected? Use this to test the websocket connection
     * between the bot and a given user before sending messages,
     * particularly in cases where a long period of time may have passed.
     *
     * Example: `bot.controller.adapter.isConnected(message.user)`
     * @param user the id of a user, typically from `message.user`
     */
    public isConnected(user: string): boolean {
        return typeof clients[user] !== 'undefined';
    }

    /**
     * Returns websocket connection of given user
     * Example: `if (message.action === 'disconnect') bot.controller.adapter.getConnection(message.user).terminate()`
     * @param user
     */
    public getConnection(user: string): WebSocket {
        if (!this.isConnected(user)) {
            throw new Error('User ' + user + ' is not connected');
        }
        return clients[user];
    }
}

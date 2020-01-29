import Logger, { LogLevel } from '@d-fischer/logger';
import { Listener } from '@d-fischer/typed-event-emitter';
import IRCClient from 'ircv3';
import { ChannelJoin, ChannelPart, Notice, PrivateMessage } from 'ircv3/lib/Message/MessageTypes/Commands/';
import TwitchClient, { CommercialLength } from 'twitch';
import TwitchCommandsCapability from './Capabilities/TwitchCommandsCapability';
import ClearChat from './Capabilities/TwitchCommandsCapability/MessageTypes/ClearChat';
import HostTarget from './Capabilities/TwitchCommandsCapability/MessageTypes/HostTarget';
import RoomState from './Capabilities/TwitchCommandsCapability/MessageTypes/RoomState';
import UserNotice from './Capabilities/TwitchCommandsCapability/MessageTypes/UserNotice';
import Whisper from './Capabilities/TwitchCommandsCapability/MessageTypes/Whisper';
import TwitchMembershipCapability from './Capabilities/TwitchMembershipCapability';
import TwitchTagsCapability from './Capabilities/TwitchTagsCapability';
import ClearMsg from './Capabilities/TwitchTagsCapability/MessageTypes/ClearMsg';
import TwitchPrivateMessage from './StandardCommands/TwitchPrivateMessage';
import { NonEnumerable } from './Toolkit/Decorators';
import { toChannelName, toUserName } from './Toolkit/UserTools';
import ChatBitsBadgeUpgradeInfo from './UserNotices/ChatBitsBadgeUpgradeInfo';
import ChatCommunityPayForwardInfo from './UserNotices/ChatCommunityPayForwardInfo';
import ChatCommunitySubInfo from './UserNotices/ChatCommunitySubInfo';
import ChatPrimeCommunityGiftInfo from './UserNotices/ChatPrimeCommunityGiftInfo';
import ChatRaidInfo from './UserNotices/ChatRaidInfo';
import ChatRitualInfo from './UserNotices/ChatRitualInfo';
import ChatStandardPayForwardInfo from './UserNotices/ChatStandardPayForwardInfo';
import ChatSubInfo, {
	ChatSubExtendInfo,
	ChatSubGiftInfo,
	ChatSubGiftUpgradeInfo,
	ChatSubUpgradeInfo
} from './UserNotices/ChatSubInfo';

const GENERIC_CHANNEL = 'twjs';

/**
 * Options for a chat client.
 */
export interface ChatClientOptions {
	/**
	 * Whether to request a token with only read permission.
	 *
	 * Ignored if `legacyScopes` is `true`.
	 */
	readOnly?: boolean;

	/**
	 * Whether to request a token with the old chat permission scope.
	 *
	 * If you're not sure whether this is necessary, just try leaving this off, and if it doesn't work, turn it on and try again.
	 */
	legacyScopes?: boolean;

	/**
	 * The minimum log level of messages that will be sent from the underlying IRC client.
	 */
	logLevel?: LogLevel;

	/**
	 * Whether to connect securely using SSL.
	 *
	 * You should not disable this except for debugging purposes.
	 */
	ssl?: boolean;

	/**
	 * Whether to use a WebSocket to connect to chat.
	 */
	webSocket?: boolean;

	/**
	 * Whether to receive JOIN and PART messages from Twitch chat.
	 */
	requestMembershipEvents?: boolean;
}

/**
 * An interface to Twitch chat.
 *
 * @inheritDoc
 * @hideProtected
 */
export default class ChatClient extends IRCClient {
	private static readonly HOST_MESSAGE_REGEX = /(\w+) is now ((?:auto[- ])?)hosting you(?: for (?:up to )?(\d+))?/;

	/** @private */
	@NonEnumerable readonly _twitchClient?: TwitchClient;

	private readonly _useLegacyScopes: boolean;
	private readonly _readOnly: boolean;

	private _authVerified = false;
	private _authFailureMessage?: string;

	private _chatLogger: Logger;

	/**
	 * Fires when a user is timed out from a channel.
	 *
	 * @eventListener
	 * @param channel The channel the user is timed out from.
	 * @param user The timed out user.
	 * @param reason The reason for the timeout.
	 * @param duration The duration of the timeout, in seconds.
	 */
	onTimeout: (
		handler: (channel: string, user: string, reason: string, duration: number, msg: ClearChat) => void
	) => Listener = this.registerEvent();

	/**
	 * Fires when a user is permanently banned from a channel.
	 *
	 * @eventListener
	 * @param channel The channel the user is banned from.
	 * @param user The banned user.
	 * @param reason The reason for the ban.
	 */
	onBan: (
		handler: (channel: string, user: string, reason: string, msg: ClearChat) => void
	) => Listener = this.registerEvent();

	/**
	 * Fires when a user upgrades their bits badge in a channel.
	 *
	 * @eventListener
	 * @param channel The channel where the bits badge was upgraded.
	 * @param user The user that has upgraded their bits badge.
	 * @param ritualInfo Additional information about the upgrade.
	 * @param msg The raw message that was received.
	 */
	onBitsBadgeUpgrade: (
		handler: (channel: string, user: string, upgradeInfo: ChatBitsBadgeUpgradeInfo, msg: UserNotice) => void
	) => Listener = this.registerEvent();

	/**
	 * Fires when the chat of a channel is cleared.
	 *
	 * @eventListener
	 * @param channel The channel whose chat is cleared.
	 */
	onChatClear: (handler: (channel: string) => void) => Listener = this.registerEvent();

	/**
	 * Fires when emote-only mode is toggled in a channel.
	 *
	 * @eventListener
	 * @param channel The channel where emote-only mode is being toggled.
	 * @param enabled Whether emote-only mode is being enabled. If false, it's being disabled.
	 */
	onEmoteOnly: (handler: (channel: string, enabled: boolean) => void) => Listener = this.registerEvent();

	/**
	 * Fires when followers-only mode is toggled in a channel.
	 *
	 * @eventListener
	 * @param channel The channel where followers-only mode is being toggled.
	 * @param enabled Whether followers-only mode is being enabled. If false, it's being disabled.
	 * @param delay The time a user needs to follow the channel to be able to talk. Only available when `enabled === true`.
	 */
	onFollowersOnly: (
		handler: (channel: string, enabled: boolean, delay?: number) => void
	) => Listener = this.registerEvent();

	/**
	 * Fires when a channel hosts another channel.
	 *
	 * @eventListener
	 * @param channel The hosting channel.
	 * @param target The channel that is being hosted.
	 * @param viewers The number of viewers in the hosting channel.
	 *
	 *   If you're not logged in as the owner of the channel, this is undefined.
	 */
	onHost: (handler: (channel: string, target: string, viewers?: number) => void) => Listener = this.registerEvent();

	/**
	 * Fires when a channel you're logged in as its owner is being hosted by another channel.
	 *
	 * @eventListener
	 * @param channel The channel that is being hosted.
	 * @param byChannel The hosting channel.
	 * @param auto Whether the host was triggered automatically (by Twitch's auto-host functionality).
	 * @param viewers The number of viewers in the hosting channel.
	 */
	onHosted: (
		handler: (channel: string, byChannel: string, auto: boolean, viewers?: number) => void
	) => Listener = this.registerEvent();

	/**
	 * Fires when Twitch tells you the number of hosts you have remaining in the next half hour for the channel
	 * for which you're logged in as owner after hosting a channel.
	 *
	 * @eventListener
	 * @param channel The hosting channel.
	 * @param numberOfHosts The number of hosts remaining in the next half hour.
	 */
	onHostsRemaining: (handler: (channel: string, numberOfHosts: number) => void) => Listener = this.registerEvent();

	/**
	 * Fires when a user joins a channel.
	 *
	 * The join/part events are cached by the Twitch chat server and will be batched and sent every 30-60 seconds.
	 *
	 * @eventListener
	 * @param channel The channel that is being joined.
	 * @param user The user that joined.
	 */
	onJoin: (handler: (channel: string, user: string) => void) => Listener = this.registerEvent();

	/**
	 * Fires when a user leaves ("parts") a channel.
	 *
	 * The join/part events are cached by the Twitch chat server and will be batched and sent every 30-60 seconds.
	 *
	 * @eventListener
	 * @param channel The channel that is being left.
	 * @param user The user that left.
	 */
	onPart: (handler: (channel: string, user: string) => void) => Listener = this.registerEvent();

	/**
	 * Fires when a single message is removed from a channel.
	 *
	 * @eventListener
	 * @param channel The channel where the message was removed.
	 * @param messageId The ID of the message that was removed.
	 * @param msg The raw message that was received.
	 *
	 * This is *not* the message that was removed. The text of the message is available using `msg.params.message` though.
	 */
	onMessageRemove: (
		handler: (channel: string, messageId: string, msg: ClearMsg) => void
	) => Listener = this.registerEvent();

	/**
	 * Fires when R9K mode is toggled in a channel.
	 *
	 * @eventListener
	 * @param channel The channel where R9K mode is being toggled.
	 * @param enabled Whether R9K mode is being enabled. If false, it's being disabled.
	 */
	onR9k: (handler: (channel: string, enabled: boolean) => void) => Listener = this.registerEvent();

	/**
	 * Fires when host mode is disabled in a channel.
	 *
	 * @eventListener
	 * @param channel The channel where host mode is being disabled.
	 */
	onUnhost: (handler: (channel: string) => void) => Listener = this.registerEvent();

	/**
	 * Fires when a user raids a channel.
	 *
	 * @eventListener
	 * @param channel The channel that was raided.
	 * @param user The user that has raided the channel.
	 * @param raidInfo Additional information about the raid.
	 * @param msg The raw message that was received.
	 */
	onRaid: (
		handler: (channel: string, user: string, raidInfo: ChatRaidInfo, msg: UserNotice) => void
	) => Listener = this.registerEvent();

	/**
	 * Fires when a user cancels a raid.
	 *
	 * @eventListener
	 * @param channel The channel where the raid was cancelled.
	 * @param msg The raw message that was received.
	 */
	onRaidCancel: (handler: (channel: string, msg: UserNotice) => void) => Listener = this.registerEvent();

	/**
	 * Fires when a user performs a "ritual" in a channel.
	 *
	 * @eventListener
	 * @param channel The channel where the ritual was performed.
	 * @param user The user that has performed the ritual.
	 * @param ritualInfo Additional information about the ritual.
	 * @param msg The raw message that was received.
	 */
	onRitual: (
		handler: (channel: string, user: string, ritualInfo: ChatRitualInfo, msg: UserNotice) => void
	) => Listener = this.registerEvent();

	/**
	 * Fires when slow mode is toggled in a channel.
	 *
	 * @eventListener
	 * @param channel The channel where slow mode is being toggled.
	 * @param enabled Whether slow mode is being enabled. If false, it's being disabled.
	 * @param delay The time a user has to wait between sending messages. Only set when enabling slow mode.
	 */
	onSlow: (handler: (channel: string, enabled: boolean, delay?: number) => void) => Listener = this.registerEvent();

	/**
	 * Fires when sub only mode is toggled in a channel.
	 *
	 * @eventListener
	 * @param channel The channel where sub only mode is being toggled.
	 * @param enabled Whether sub only mode is being enabled. If false, it's being disabled.
	 */
	onSubsOnly: (handler: (channel: string, enabled: boolean) => void) => Listener = this.registerEvent();

	/**
	 * Fires when a user subscribes to a channel.
	 *
	 * @eventListener
	 * @param channel The channel that was subscribed to.
	 * @param user The subscribing user.
	 * @param subInfo Additional information about the subscription.
	 * @param msg The raw message that was received.
	 */
	onSub: (
		handler: (channel: string, user: string, subInfo: ChatSubInfo, msg: UserNotice) => void
	) => Listener = this.registerEvent();

	/**
	 * Fires when a user resubscribes to a channel.
	 *
	 * @eventListener
	 * @param channel The channel that was resubscribed to.
	 * @param user The resubscribing user.
	 * @param subInfo Additional information about the resubscription.
	 * @param msg The raw message that was received.
	 */
	onResub: (
		handler: (channel: string, user: string, subInfo: ChatSubInfo, msg: UserNotice) => void
	) => Listener = this.registerEvent();

	/**
	 * Fires when a user gifts a subscription to a channel to another user.
	 *
	 * @eventListener
	 * @param channel The channel that was subscribed to.
	 * @param user The user that the subscription was gifted to. The gifting user is defined in `subInfo.gifter`.
	 * @param subInfo Additional information about the subscription.
	 * @param msg The raw message that was received.
	 */
	onSubGift: (
		handler: (channel: string, user: string, subInfo: ChatSubGiftInfo, msg: UserNotice) => void
	) => Listener = this.registerEvent();

	/**
	 * Fires when a user gifts random subscriptions to the community of a channel.
	 *
	 * @eventListener
	 * @param channel The channel that was subscribed to.
	 * @param user The gifting user.
	 * @param subInfo Additional information about the community subscription.
	 * @param msg The raw message that was received.
	 */
	onCommunitySub: (
		handler: (channel: string, user: string, subInfo: ChatCommunitySubInfo, msg: UserNotice) => void
	) => Listener = this.registerEvent();

	/**
	 * Fires when a user extends their subscription using a Sub Token.
	 *
	 * @eventListener
	 * @param channel The channel where the subscription was extended.
	 * @param user The user that extended their subscription.
	 * @param subInfo Additional information about the subscription extension.
	 * @param msg The raw message that was received.
	 */
	onSubExtend: (
		handler: (channel: string, user: string, subInfo: ChatSubExtendInfo, msg: UserNotice) => void
	) => Listener = this.registerEvent();

	/**
	 * Fires when a user upgrades their Prime subscription to a paid subscription in a channel.
	 *
	 * @eventListener
	 * @param channel The channel where the subscription was upgraded.
	 * @param user The user that upgraded their subscription.
	 * @param subInfo Additional information about the subscription upgrade.
	 * @param msg The raw message that was received.
	 */
	onPrimePaidUpgrade: (
		handler: (channel: string, user: string, subInfo: ChatSubUpgradeInfo, msg: UserNotice) => void
	) => Listener = this.registerEvent();

	/**
	 * Fires when a user upgrades their gift subscription to a paid subscription in a channel.
	 *
	 * @eventListener
	 * @param channel The channel where the subscription was upgraded.
	 * @param user The user that upgraded their subscription.
	 * @param subInfo Additional information about the subscription upgrade.
	 * @param msg The raw message that was received.
	 */
	onGiftPaidUpgrade: (
		handler: (channel: string, user: string, subInfo: ChatSubGiftUpgradeInfo, msg: UserNotice) => void
	) => Listener = this.registerEvent();

	/**
	 * Fires when a user gifts a Twitch Prime benefit to the channel.
	 *
	 * @eventListener
	 * @param channel The channel where the benefit was gifted.
	 * @param user The user that received the gift.
	 *
	 * **WARNING:** This is a *display name* and thus will not work as an identifier for the API (login) in some cases.
	 * @param subInfo Additional information about the gift.
	 * @param msg The raw message that was received.
	 */
	onPrimeCommunityGift: (
		handler: (channel: string, user: string, subInfo: ChatPrimeCommunityGiftInfo, msg: UserNotice) => void
	) => Listener = this.registerEvent();

	/**
	 * Fires when a user pays forward a subscription that was gifted to them to a specific user.
	 *
	 * @eventListener
	 * @param channel The channel where the gift was forwarded.
	 * @param user The user that forwarded the gift.
	 * @param forwardInfo Additional information about the gift.
	 * @param msg The raw message that was received.
	 */
	onStandardPayForward: (
		handler: (channel: string, user: string, forwardInfo: ChatStandardPayForwardInfo, msg: UserNotice) => void
	) => Listener = this.registerEvent();

	/**
	 * Fires when a user pays forward a subscription that was gifted to them to the community.
	 *
	 * @eventListener
	 * @param channel The channel where the gift was forwarded.
	 * @param user The user that forwarded the gift.
	 * @param forwardInfo Additional information about the gift.
	 * @param msg The raw message that was received.
	 */
	onCommunityPayForward: (
		handler: (channel: string, user: string, forwardInfo: ChatCommunityPayForwardInfo, msg: UserNotice) => void
	) => Listener = this.registerEvent();

	/**
	 * Fires when receiving a whisper from another user.
	 *
	 * @eventListener
	 * @param user The user that sent the whisper.
	 * @param message The message text.
	 * @param msg The raw message that was received.
	 */
	onWhisper: (handler: (user: string, message: string, msg: Whisper) => void) => Listener = this.registerEvent();

	/**
	 * Fires when you tried to execute a command you don't have sufficient permission for.
	 *
	 * @eventListener
	 * @param channel The channel that a command without sufficient permissions was executed on.
	 * @param message The message text.
	 */
	onNoPermission: (handler: (channel: string, message: string) => void) => Listener = this.registerEvent();

	/**
	 * Fires when a message you tried to send gets rejected by the ratelimiter.
	 *
	 * @eventListener
	 * @param channel The channel that was attempted to send to.
	 * @param message The message text.
	 */
	onMessageRatelimit: (handler: (channel: string, message: string) => void) => Listener = this.registerEvent();

	/**
	 * Fires when authentication fails.
	 *
	 * @eventListener
	 * @param channel The channel that a command without sufficient permissions was executed on.
	 * @param message The message text.
	 */
	onAuthenticationFailure: (handler: (message: string) => void) => Listener = this.registerEvent();

	/**
	 * Fires when sending a message fails.
	 *
	 * @eventListener
	 * @param channel The channel that rejected the message.
	 * @param reason The reason for the failure, e.g. you're banned (msg_banned)
	 */
	onMessageFailed: (handler: (channel: string, reason: string) => void) => Listener = this.registerEvent();

	// override for specific class
	/**
	 * Fires when a user sends a message to a channel.
	 *
	 * @eventListener
	 * @param channel The channel the message was sent to.
	 * @param user The user that send the message.
	 * @param message The message text.
	 * @param msg The raw message that was received.
	 */
	onPrivmsg!: (
		handler: (channel: string, user: string, message: string, msg: TwitchPrivateMessage) => void
	) => Listener;

	/**
	 * Fires when a user sends an action (/me) to a channel.
	 *
	 * @eventListener
	 * @param channel The channel the action was sent to.
	 * @param user The user that send the action.
	 * @param message The action text.
	 * @param msg The raw message that was received.
	 */
	onAction!: (
		handler: (channel: string, user: string, message: string, msg: TwitchPrivateMessage) => void
	) => Listener;

	// internal events to resolve promises and stuff
	private readonly _onBanResult: (
		handler: (channel: string, user: string, error?: string) => void
	) => Listener = this.registerEvent();
	private readonly _onTimeoutResult: (
		handler: (
			channel: string,
			user: string,
			reason?: string,
			duration?: number,
			msg?: ClearChat,
			error?: string
		) => void
	) => Listener = this.registerEvent();
	private readonly _onUnbanResult: (
		handler: (channel: string, user: string, error?: string) => void
	) => Listener = this.registerEvent();
	private readonly _onColorResult: (handler: (error?: string) => void) => Listener = this.registerEvent();
	private readonly _onCommercialResult: (
		handler: (channel: string, error?: string) => void
	) => Listener = this.registerEvent();
	private readonly _onDeleteMessageResult: (
		handler: (channel: string, error?: string) => void
	) => Listener = this.registerEvent();
	private readonly _onEmoteOnlyResult: (
		handler: (channel: string, error?: string) => void
	) => Listener = this.registerEvent();
	private readonly _onEmoteOnlyOffResult: (
		handler: (channel: string, error?: string) => void
	) => Listener = this.registerEvent();
	private readonly _onFollowersOnlyResult: (
		handler: (channel: string, delay?: number, error?: string) => void
	) => Listener = this.registerEvent();
	private readonly _onFollowersOnlyOffResult: (
		handler: (channel: string, error?: string) => void
	) => Listener = this.registerEvent();
	private readonly _onHostResult: (
		handler: (channel: string, error?: string) => void
	) => Listener = this.registerEvent();
	private readonly _onUnhostResult: (
		handler: (channel: string, error?: string) => void
	) => Listener = this.registerEvent();
	private readonly _onModResult: (
		handler: (channel: string, user: string, error?: string) => void
	) => Listener = this.registerEvent();
	private readonly _onUnmodResult: (
		handler: (channel: string, user: string, error?: string) => void
	) => Listener = this.registerEvent();
	private readonly _onModsResult: (
		handler: (channel: string, mods?: string[], error?: string) => void
	) => Listener = this.registerEvent();
	private readonly _onJoinResult: (
		handler: (channel: string, state?: Map<string, string>, error?: string) => void
	) => Listener = this.registerEvent();
	private readonly _onR9kResult: (
		handler: (channel: string, error?: string) => void
	) => Listener = this.registerEvent();
	private readonly _onR9kOffResult: (
		handler: (channel: string, error?: string) => void
	) => Listener = this.registerEvent();
	private readonly _onSlowResult: (
		handler: (channel: string, delay?: number, error?: string) => void
	) => Listener = this.registerEvent();
	private readonly _onSlowOffResult: (
		handler: (channel: string, error?: string) => void
	) => Listener = this.registerEvent();
	private readonly _onSubsOnlyResult: (
		handler: (channel: string, error?: string) => void
	) => Listener = this.registerEvent();
	private readonly _onSubsOnlyOffResult: (
		handler: (channel: string, error?: string) => void
	) => Listener = this.registerEvent();
	private readonly _onVipResult: (
		handler: (channel: string, user: string, error?: string) => void
	) => Listener = this.registerEvent();
	private readonly _onUnvipResult: (
		handler: (channel: string, user: string, error?: string) => void
	) => Listener = this.registerEvent();
	private readonly _onVipsResult: (
		handler: (channel: string, vips?: string[], error?: string) => void
	) => Listener = this.registerEvent();

	/**
	 * Creates a new Twitch chat client with the user info from the TwitchClient instance.
	 *
	 * @expandParams
	 *
	 * @param twitchClient The TwitchClient instance to use for user info and API requests.
	 * @param options
	 */
	static async forTwitchClient(twitchClient: TwitchClient, options: ChatClientOptions = {}) {
		return new this(twitchClient, options);
	}

	/**
	 * Creates a new anonymous Twitch chat client.
	 *
	 * @expandParams
	 *
	 * @param options
	 */
	static anonymous(options: ChatClientOptions = {}) {
		return new this(undefined, options);
	}

	/**
	 * Creates a new Twitch chat client.
	 *
	 * @expandParams
	 *
	 * @param twitchClient The {@TwitchClient} instance to use for API requests.
	 * @param options
	 */
	constructor(twitchClient: TwitchClient | undefined, options: ChatClientOptions) {
		/* eslint-disable no-restricted-syntax */
		super({
			connection: {
				hostName: options.webSocket === false ? 'irc.chat.twitch.tv' : 'irc-ws.chat.twitch.tv',
				secure: options.ssl !== false
			},
			credentials: {
				nick: ''
			},
			webSocket: options.webSocket !== false,
			logLevel: options.logLevel,
			nonConformingCommands: ['004']
		});
		/* eslint-enable no-restricted-syntax */

		this._chatLogger = new Logger({ name: 'twitch-chat', emoji: true, minLevel: options.logLevel });

		this._twitchClient = twitchClient;

		this._useLegacyScopes = !!options.legacyScopes;
		this._readOnly = !!options.readOnly;

		// tslint:disable:no-floating-promises
		this.registerCapability(TwitchTagsCapability);
		this.registerCapability(TwitchCommandsCapability);
		if (options.requestMembershipEvents) {
			this.registerCapability(TwitchMembershipCapability);
		}
		// tslint:enable:no-floating-promises

		this.onRegister(() => {
			this._authVerified = true;
			this._authFailureMessage = undefined;
		});

		this.onMessage(ClearChat, clearChat => {
			const {
				params: { channel, user },
				tags
			} = clearChat;
			if (user) {
				const duration = tags.get('ban-duration');
				const reason = tags.get('ban-reason');
				if (duration === undefined) {
					// ban
					this.emit(this.onBan, channel, user, reason, clearChat);
				} else {
					// timeout
					this.emit(this.onTimeout, channel, user, reason, Number(duration), clearChat);
					this.emit(this._onTimeoutResult, channel, user, reason, Number(duration), clearChat);
				}
			} else {
				// full chat clear
				this.emit(this.onChatClear, channel);
			}
		});

		this.onMessage(ClearMsg, msg => {
			const {
				params: { channel },
				targetMessageId
			} = msg;
			this.emit(this.onMessageRemove, channel, targetMessageId, msg);
		});

		this.onMessage(HostTarget, ({ params: { channel, targetAndViewers } }) => {
			const [target, viewers] = targetAndViewers.split(' ');
			if (target === '-') {
				// unhost
				this.emit(this.onUnhost, channel);
			} else {
				const numViewers = Number(viewers);
				this.emit(this.onHost, channel, target, isNaN(numViewers) ? undefined : numViewers);
			}
		});

		this.onMessage(ChannelJoin, ({ prefix, params: { channel } }) => {
			this.emit(this.onJoin, channel, prefix!.nick);
		});

		this.onMessage(ChannelPart, ({ prefix, params: { channel } }: ChannelPart) => {
			this.emit(this.onPart, channel, prefix!.nick);
		});

		this.onMessage(TwitchPrivateMessage, ({ prefix, params: { target: channel, message } }) => {
			if (prefix && prefix.nick === 'jtv') {
				// 1 = who hosted
				// 2 = auto-host or not
				// 3 = how many viewers (not always present)
				const match = message.match(ChatClient.HOST_MESSAGE_REGEX);
				if (match) {
					this.emit(
						this.onHosted,
						channel,
						match[1],
						Boolean(match[2]),
						match[3] === '' ? undefined : Number(match[3])
					);
				}
			}
		});

		this.onMessage(RoomState, ({ params: { channel }, tags }) => {
			let isInitial = false;
			if (tags.has('subs-only') && tags.has('slow')) {
				// this is the full state - so we just successfully joined
				this.emit(this._onJoinResult, channel, tags);
				isInitial = true;
			}

			if (tags.has('slow')) {
				const slowDelay = Number(tags.get('slow'));
				if (slowDelay) {
					this.emit(this._onSlowResult, channel, slowDelay);
					if (!isInitial) {
						this.emit(this.onSlow, channel, true, slowDelay);
					}
				} else {
					this.emit(this._onSlowOffResult, channel);
					if (!isInitial) {
						this.emit(this.onSlow, channel, false);
					}
				}
			}

			if (tags.has('followers-only')) {
				const followDelay = Number(tags.get('followers-only'));
				if (followDelay === -1) {
					this.emit(this._onFollowersOnlyOffResult, channel);
					if (!isInitial) {
						this.emit(this.onFollowersOnly, channel, false);
					}
				} else {
					this.emit(this._onFollowersOnlyResult, channel, followDelay);
					if (!isInitial) {
						this.emit(this.onFollowersOnly, channel, true, followDelay);
					}
				}
			}
		});

		this.onMessage(UserNotice, userNotice => {
			const {
				params: { channel, message },
				tags
			} = userNotice;
			const messageType = tags.get('msg-id');

			switch (messageType) {
				case 'sub':
				case 'resub': {
					const event = messageType === 'sub' ? this.onSub : this.onResub;
					const plan = tags.get('msg-param-sub-plan')!;
					const streakMonths = tags.get('msg-param-streak-months');
					const subInfo: ChatSubInfo = {
						userId: tags.get('user-id')!,
						displayName: tags.get('display-name')!,
						plan,
						planName: tags.get('msg-param-sub-plan-name')!,
						isPrime: plan === 'Prime',
						months: Number(tags.get('msg-param-cumulative-months')),
						streak: streakMonths ? Number(streakMonths) : undefined,
						message
					};
					this.emit(event, channel, tags.get('login')!, subInfo, userNotice);
					break;
				}
				case 'subgift':
				case 'anonsubgift': {
					const plan = tags.get('msg-param-sub-plan')!;
					const gifter = tags.get('login');
					const isAnon = messageType === 'anonsubgift' || gifter === 'ananonymousgifter';
					const subInfo: ChatSubGiftInfo = {
						userId: tags.get('msg-param-recipient-id')!,
						displayName: tags.get('msg-param-recipient-display-name')!,
						gifter: isAnon ? undefined : gifter,
						gifterUserId: isAnon ? undefined : tags.get('user-id')!,
						gifterDisplayName: isAnon ? undefined : tags.get('display-name')!,
						gifterGiftCount: isAnon ? undefined : Number(tags.get('msg-param-sender-count')!),
						plan,
						planName: tags.get('msg-param-sub-plan-name')!,
						isPrime: plan === 'Prime',
						months: Number(tags.get('msg-param-months'))
					};
					this.emit(this.onSubGift, channel, tags.get('msg-param-recipient-user-name')!, subInfo, userNotice);
					break;
				}
				case 'anonsubmysterygift':
				case 'submysterygift': {
					const gifter = tags.get('login');
					const isAnon = messageType === 'anonsubmysterygift' || gifter === 'ananonymousgifter';
					const communitySubInfo: ChatCommunitySubInfo = {
						gifter: isAnon ? undefined : gifter,
						gifterUserId: isAnon ? undefined : tags.get('user-id')!,
						gifterDisplayName: isAnon ? undefined : tags.get('display-name')!,
						gifterGiftCount: isAnon ? undefined : Number(tags.get('msg-param-sender-count')!),
						count: Number(tags.get('msg-param-mass-gift-count')!),
						plan: tags.get('msg-param-sub-plan')!
					};
					this.emit(this.onCommunitySub, channel, tags.get('login')!, communitySubInfo, userNotice);
					break;
				}
				case 'primepaidupgrade': {
					const upgradeInfo: ChatSubUpgradeInfo = {
						userId: tags.get('user-id')!,
						displayName: tags.get('display-name')!,
						plan: tags.get('msg-param-sub-plan')!
					};
					this.emit(this.onPrimePaidUpgrade, channel, tags.get('login')!, upgradeInfo, userNotice);
					break;
				}
				case 'giftpaidupgrade': {
					const upgradeInfo: ChatSubGiftUpgradeInfo = {
						userId: tags.get('user-id')!,
						displayName: tags.get('display-name')!,
						plan: tags.get('msg-param-sub-plan')!,
						gifter: tags.get('msg-param-sender-login')!,
						gifterDisplayName: tags.get('msg-param-sender-name')!
					};
					this.emit(this.onGiftPaidUpgrade, channel, tags.get('login')!, upgradeInfo, userNotice);
					break;
				}
				case 'standardpayforward': {
					const wasAnon = tags.get('msg-param-prior-gifter-anonymous') === 'true';
					const forwardInfo: ChatStandardPayForwardInfo = {
						userId: tags.get('user-id')!,
						displayName: tags.get('display-name')!,
						originalGifterUserId: wasAnon ? undefined : tags.get('msg-param-prior-gifter-id')!,
						originalGifterDisplayName: wasAnon
							? undefined
							: tags.get('msg-param-prior-gifter-display-name')!,
						recipientUserId: tags.get('msg-param-recipient-id')!,
						recipientDisplayName: tags.get('msg-param-recipient-display-name')!
					};
					this.emit(this.onStandardPayForward, channel, tags.get('login')!, forwardInfo, userNotice);
					break;
				}
				case 'communitypayforward': {
					const wasAnon = tags.get('msg-param-prior-gifter-anonymous') === 'true';
					const forwardInfo: ChatCommunityPayForwardInfo = {
						userId: tags.get('user-id')!,
						displayName: tags.get('display-name')!,
						originalGifterUserId: wasAnon ? undefined : tags.get('msg-param-prior-gifter-id')!,
						originalGifterDisplayName: wasAnon
							? undefined
							: tags.get('msg-param-prior-gifter-display-name')!
					};
					this.emit(this.onCommunityPayForward, channel, tags.get('login')!, forwardInfo, userNotice);
					break;
				}
				case 'primecommunitygiftreceived': {
					const giftInfo: ChatPrimeCommunityGiftInfo = {
						name: tags.get('msg-param-gift-name')!,
						gifter: tags.get('login')!,
						gifterDisplayName: tags.get('display-name')!
					};
					this.emit(
						this.onPrimeCommunityGift,
						channel,
						tags.get('msg-param-recipient')!,
						giftInfo,
						userNotice
					);
					break;
				}
				case 'raid': {
					const raidInfo: ChatRaidInfo = {
						displayName: tags.get('msg-param-displayName')!,
						viewerCount: Number(tags.get('msg-param-viewerCount'))
					};
					this.emit(this.onRaid, channel, tags.get('login')!, raidInfo, userNotice);
					break;
				}
				case 'unraid': {
					this.emit(this.onRaidCancel, channel, userNotice);
					break;
				}
				case 'ritual': {
					const ritualInfo: ChatRitualInfo = {
						ritualName: tags.get('msg-param-ritual-name')!,
						message
					};
					this.emit(this.onRitual, channel, tags.get('login')!, ritualInfo, userNotice);
					break;
				}
				case 'bitsbadgetier': {
					const badgeUpgradeInfo: ChatBitsBadgeUpgradeInfo = {
						displayName: tags.get('display-name')!,
						threshold: Number(tags.get('msg-param-threshold'))
					};
					this.emit(this.onBitsBadgeUpgrade, channel, tags.get('login')!, badgeUpgradeInfo, userNotice);
					break;
				}
				case 'extendsub': {
					const extendInfo: ChatSubExtendInfo = {
						userId: tags.get('user-id')!,
						displayName: tags.get('display-name')!,
						plan: tags.get('msg-param-sub-plan')!,
						months: Number(tags.get('msg-param-cumulative-months')),
						endMonth: Number(tags.get('msg-param-sub-benefit-end-month'))
					};
					this.emit(this.onSubExtend, channel, tags.get('login')!, extendInfo, userNotice);
					break;
				}
				default: {
					this._chatLogger.warn(`Unrecognized usernotice ID: ${messageType}`);
				}
			}
		});

		this.onMessage(Whisper, whisper => {
			this.emit(this.onWhisper, whisper.prefix!.nick, whisper.params.message, whisper);
		});

		this.onMessage(Notice, userNotice => {
			const {
				params: { target: channel, message },
				tags
			} = userNotice;
			const messageType = tags.get('msg-id');

			// this event handler involves a lot of parsing strings you shouldn't parse...
			// but Twitch doesn't give us the required info in tags (╯°□°）╯︵ ┻━┻
			// (this code also might not do the right thing with foreign character display names...)
			switch (messageType) {
				// ban
				case 'already_banned': {
					const match = message.split(' ');
					const user = match && /^\w+$/.test(match[0]) ? match[0] : undefined;
					if (user) {
						this.emit(this._onBanResult, channel, user, messageType);
					}
					break;
				}

				case 'bad_ban_self': {
					this.emit(this._onBanResult, channel, this._credentials.nick, messageType);
					break;
				}

				case 'bad_ban_broadcaster': {
					this.emit(this._onBanResult, channel, toUserName(channel), messageType);
					break;
				}

				case 'bad_ban_admin':
				case 'bad_ban_global_mod':
				case 'bad_ban_staff': {
					const match = message.match(/^You cannot ban (?:\w+ )+?(\w+)\.$/);
					if (match) {
						this.emit(this._onBanResult, channel, match[1].toLowerCase(), messageType);
					}
					break;
				}

				case 'ban_success': {
					const match = message.split(' ');
					const user = match && /^\w+$/.test(match[0]) ? match[0] : undefined;
					if (user) {
						this.emit(this._onBanResult, channel, user);
					}
					break;
				}

				// unban
				case 'bad_unban_no_ban': {
					const match = message.split(' ');
					const user = match && /^\w+$/.test(match[0]) ? match[0] : undefined;
					if (user) {
						this.emit(this._onUnbanResult, channel, user, messageType);
					}
					break;
				}

				case 'unban_success': {
					const match = message.split(' ');
					const user = match && /^\w+$/.test(match[0]) ? match[0] : undefined;
					if (user) {
						this.emit(this._onUnbanResult, channel, user);
					}
					break;
				}

				// color
				case 'turbo_only_color': {
					this.emit(this._onColorResult, messageType);
					break;
				}

				case 'color_changed': {
					this.emit(this._onColorResult);
					break;
				}

				// commercial
				case 'bad_commercial_error': {
					this.emit(this._onCommercialResult, channel, messageType);
					break;
				}

				case 'commercial_success': {
					this.emit(this._onCommercialResult, channel);
					break;
				}

				// delete message
				case 'bad_delete_message_error':
				case 'bad_delete_message_broadcaster':
				case 'bad_delete_message_mod': {
					this.emit(this._onDeleteMessageResult, channel, messageType);
					break;
				}

				case 'delete_message_success': {
					this.emit(this._onDeleteMessageResult, channel);
					break;
				}

				// emote only
				case 'already_emote_only_on': {
					this.emit(this._onEmoteOnlyResult, channel, messageType);
					break;
				}

				case 'emote_only_on': {
					this.emit(this._onEmoteOnlyResult, channel);
					this.emit(this.onEmoteOnly, channel, true);
					break;
				}

				// emote only off
				case 'already_emote_only_off': {
					this.emit(this._onEmoteOnlyOffResult, channel, messageType);
					break;
				}

				case 'emote_only_off': {
					this.emit(this._onEmoteOnlyOffResult, channel);
					this.emit(this.onEmoteOnly, channel, false);
					break;
				}

				// host
				case 'bad_host_hosting':
				case 'bad_host_rate_exceeded':
				case 'bad_host_error': {
					this.emit(this._onHostResult, channel, messageType);
					break;
				}

				case 'hosts_remaining': {
					const remainingHostsFromChar = +message[0];
					const remainingHosts = isNaN(remainingHostsFromChar) ? 0 : Number(remainingHostsFromChar);
					this.emit(this._onHostResult, channel);
					this.emit(this.onHostsRemaining, channel, remainingHosts);
					break;
				}

				// unhost (only fails, success is handled by HOSTTARGET)
				case 'not_hosting': {
					this.emit(this._onUnhostResult, channel, messageType);
					break;
				}

				// join (success is handled when ROOMSTATE comes in)
				case 'msg_channel_suspended': {
					this.emit(this._onJoinResult, channel, undefined, messageType);
					break;
				}

				// mod
				case 'bad_mod_banned':
				case 'bad_mod_mod': {
					const match = message.split(' ');
					const user = match && /^\w+$/.test(match[0]) ? match[0] : undefined;
					if (user) {
						this.emit(this._onModResult, channel, user, messageType);
					}
					break;
				}

				case 'mod_success': {
					const match = message.match(/^You have added (\w+) /);
					if (match) {
						this.emit(this._onModResult, channel, match[1]);
					}
					break;
				}

				// unmod
				case 'bad_unmod_mod': {
					const match = message.split(' ');
					const user = match && /^\w+$/.test(match[0]) ? match[0] : undefined;
					if (user) {
						this.emit(this._onUnmodResult, channel, user, messageType);
					}
					break;
				}

				case 'unmod_success': {
					const match = message.match(/^You have removed (\w+) /);
					if (match) {
						this.emit(this._onUnmodResult, channel, match[1]);
					}
					break;
				}

				// mods
				case 'no_mods': {
					this.emit(this._onModsResult, channel, []);
					break;
				}

				case 'room_mods': {
					const [, modList] = message.split(': ');
					const mods = modList.split(', ');
					this.emit(this._onModsResult, channel, mods);
					break;
				}

				// r9k
				case 'already_r9k_on': {
					this.emit(this._onR9kResult, channel, messageType);
					break;
				}

				case 'r9k_on': {
					this.emit(this._onR9kResult, channel);
					this.emit(this.onR9k, channel, true);
					break;
				}

				// r9k off
				case 'already_r9k_off': {
					this.emit(this._onR9kOffResult, channel, messageType);
					break;
				}

				case 'r9k_off': {
					this.emit(this._onR9kOffResult, channel);
					this.emit(this.onR9k, channel, false);
					break;
				}

				// subs only
				case 'already_subs_on': {
					this.emit(this._onSubsOnlyResult, channel, messageType);
					break;
				}

				case 'subs_on': {
					this.emit(this._onSubsOnlyResult, channel);
					this.emit(this.onSubsOnly, channel, true);
					break;
				}

				// subs only off
				case 'already_subs_off': {
					this.emit(this._onSubsOnlyOffResult, channel, messageType);
					break;
				}

				case 'subs_off': {
					this.emit(this._onSubsOnlyOffResult, channel);
					this.emit(this.onSubsOnly, channel, false);
					break;
				}

				// timeout (only fails, success is handled by CLEARCHAT)
				case 'bad_timeout_self': {
					this.emit(
						this._onTimeoutResult,
						channel,
						this._credentials.nick,
						undefined,
						undefined,
						undefined,
						messageType
					);
					break;
				}

				case 'bad_timeout_broadcaster': {
					this.emit(
						this._onTimeoutResult,
						channel,
						toUserName(channel),
						undefined,
						undefined,
						undefined,
						messageType
					);
					break;
				}

				case 'bad_timeout_admin':
				case 'bad_timeout_global_mod':
				case 'bad_timeout_staff': {
					const match = message.match(/^You cannot ban (?:\w+ )+?(\w+)\.$/);
					if (match) {
						this.emit(
							this._onTimeoutResult,
							channel,
							match[1].toLowerCase(),
							undefined,
							undefined,
							undefined,
							messageType
						);
					}
					break;
				}

				// vip
				case 'bad_vip_grantee_banned':
				case 'bad_vip_grantee_already_vip': {
					const match = message.split(' ');
					const user = match && /^\w+$/.test(match[0]) ? match[0] : undefined;
					if (user) {
						this.emit(this._onVipResult, channel, user, messageType);
					}
					break;
				}

				case 'vip_success': {
					const match = message.match(/^You have added (\w+) /);
					if (match) {
						this.emit(this._onVipResult, channel, match[1]);
					}
					break;
				}

				// unvip
				case 'bad_unvip_grantee_not_vip': {
					const match = message.split(' ');
					const user = match && /^\w+$/.test(match[0]) ? match[0] : undefined;
					if (user) {
						this.emit(this._onUnvipResult, channel, user, messageType);
					}
					break;
				}

				case 'unvip_success': {
					const match = message.match(/^You have removed (\w+) /);
					if (match) {
						this.emit(this._onUnvipResult, channel, match[1]);
					}
					break;
				}

				// vips
				case 'no_vips': {
					this.emit(this._onVipsResult, channel, []);
					break;
				}

				case 'vips_success': {
					const [, vipList] = message.split(': ');
					const vips = vipList.split(', ');
					this.emit(this._onVipsResult, channel, vips);
					break;
				}

				case 'cmds_available': {
					// do we really care?
					break;
				}

				// there's other messages that show us the following things...
				// ...like ROOMSTATE...
				case 'followers_on':
				case 'followers_on_zero':
				case 'followers_off':
				case 'slow_on':
				case 'slow_off': {
					break;
				}

				// ...and CLEARCHAT...
				case 'timeout_success': {
					break;
				}

				// ...and HOSTTARGET
				case 'host_off':
				case 'host_on':
				case 'host_target_went_offline': {
					break;
				}

				case 'unrecognized_cmd': {
					break;
				}

				case 'no_permission': {
					this.emit(this.onNoPermission, channel, message);
					break;
				}

				case 'msg_ratelimit': {
					this.emit(this.onMessageRatelimit, channel, message);
					break;
				}

				case 'msg_banned': {
					this.emit(this.onMessageFailed, channel, messageType);
					break;
				}

				case undefined: {
					// this might be one of these weird authentication error notices that don't have a msg-id...
					if (
						message === 'Login authentication failed' ||
						message === 'Improperly formatted AUTH' ||
						message === 'Invalid NICK'
					) {
						this._authVerified = false;
						this._authFailureMessage = message;
						this.emit(this.onAuthenticationFailure, message);
						this._connection!.disconnect();
					}
					break;
				}

				default: {
					if (!messageType || messageType.substr(0, 6) !== 'usage_') {
						this._chatLogger.warn(`Unrecognized notice ID: '${messageType}'`);
					}
				}
			}
		});
	}

	async connect() {
		if (!this._twitchClient) {
			this._updateCredentials({
				nick: ChatClient._generateJustinfanNick(),
				password: undefined
			});
		}

		await super.connect();
	}

	// TODO swap arguments in 4.0
	/**
	 * Hosts a channel on another channel.
	 *
	 * @param target The host target, i.e. the channel that is being hosted.
	 * @param channel The host source, i.e. the channel that is hosting. Defaults to the channel of the connected user.
	 */
	async host(target: string, channel: string = this._credentials.nick) {
		channel = toUserName(channel);
		return new Promise<void>((resolve, reject) => {
			const e = this._onHostResult((chan, error) => {
				if (toUserName(chan) === channel) {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
					this.removeListener(e);
				}
			});
			this.say(channel, `/host ${target}`);
		});
	}

	/**
	 * Ends any host on a channel.
	 *
	 * This only works when in the channel that was hosted in order to provide feedback about success of the command.
	 *
	 * If you don't need this feedback, consider using {@ChatClient#unhostOutside} instead.
	 *
	 * @param channel The channel to end the host on. Defaults to the channel of the connected user.
	 */
	async unhost(channel: string = this._credentials.nick) {
		channel = toUserName(channel);
		return new Promise<void>((resolve, reject) => {
			const e = this._onUnhostResult((chan, error) => {
				if (toUserName(chan) === channel) {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
					this.removeListener(e);
				}
			});
			this.say(channel, '/unhost');
		});
	}

	/**
	 * Ends any host on a channel.
	 *
	 * This works even when not in the channel that was hosted, but provides no feedback about success of the command.
	 *
	 * If you need feedback about success, use {@ChatClient#unhost} (but make sure you're in the channel you are hosting).
	 *
	 * @param channel The channel to end the host on. Defaults to the channel of the connected user.
	 */
	unhostOutside(channel: string = this._credentials.nick) {
		this.say(channel, '/unhost');
	}

	/**
	 * Bans a user from a channel.
	 *
	 * This only works when in the channel that was hosted in order to provide feedback about success of the command.
	 *
	 * @param channel The channel to ban the user from. Defaults to the channel of the connected user.
	 * @param user The user to ban from the channel.
	 * @param reason The reason for the ban.
	 */
	async ban(channel: string = this._credentials.nick, user: string, reason: string = '') {
		channel = toUserName(channel);
		user = toUserName(user);
		return new Promise<void>((resolve, reject) => {
			const e = this._onBanResult((_channel, _user, error) => {
				if (toUserName(_channel) === channel && toUserName(_user) === user) {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
					this.removeListener(e);
				}
			});
			this.say(channel, `/ban ${user} ${reason}`);
		});
	}

	/**
	 * Clears all messages in a channel.
	 *
	 * This only works when in the channel that was hosted in order to provide feedback about success of the command.
	 *
	 * @param channel The channel to ban the user from. Defaults to the channel of the connected user.
	 */
	async clear(channel: string = this._credentials.nick) {
		channel = toUserName(channel);
		return new Promise<void>(resolve => {
			const e = this.onChatClear(_channel => {
				if (toUserName(_channel) === channel) {
					resolve();
					this.removeListener(e);
				}
			});
			this.say(channel, '/clear');
		});
	}

	/**
	 * Changes your username color.
	 *
	 * @param color The hexadecimal code (prefixed with #) or color name to use for your username.
	 *
	 * Please note that only Twitch Turbo or Prime users can use hexadecimal codes for arbitrary colors.
	 *
	 * If you have neither of those, you can only choose from the following color names:
	 *
	 * Blue, BlueViolet, CadetBlue, Chocolate, Coral, DodgerBlue, Firebrick, GoldenRod, Green, HotPink, OrangeRed, Red, SeaGreen, SpringGreen, YellowGreen
	 */
	async changeColor(color: string) {
		return new Promise<void>((resolve, reject) => {
			const e = this._onColorResult(error => {
				if (error) {
					reject(error);
				} else {
					resolve();
				}
				this.removeListener(e);
			});
			this.say(GENERIC_CHANNEL, `/color ${color}`);
		});
	}

	/**
	 * Runs a commercial break on a channel.
	 *
	 * @param channel The channel to run the commercial break on.
	 * @param duration The duration of the commercial break.
	 */
	async runCommercial(channel: string, duration: CommercialLength) {
		channel = toUserName(channel);
		return new Promise<void>((resolve, reject) => {
			const e = this._onCommercialResult((_channel, error) => {
				if (toUserName(_channel) === channel) {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
					this.removeListener(e);
				}
			});
			this.say(channel, `/commercial ${duration}`);
		});
	}

	/**
	 * Deletes a message from a channel.
	 *
	 * @param channel The channel to delete the message from.
	 * @param message The message (as message ID or message object) to delete.
	 */
	async deleteMessage(channel: string, message: string | PrivateMessage) {
		channel = toUserName(channel);
		const messageId = message instanceof PrivateMessage ? message.tags.get('id') : message;
		return new Promise<void>((resolve, reject) => {
			const e = this._onDeleteMessageResult((_channel, error) => {
				if (toUserName(_channel) === channel) {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
					this.removeListener(e);
				}
			});
			this.say(channel, `/delete ${messageId}`);
		});
	}

	/**
	 * Enables emote-only mode in a channel.
	 *
	 * @param channel The channel to enable emote-only mode in.
	 */
	async enableEmoteOnly(channel: string) {
		channel = toUserName(channel);
		return new Promise<void>((resolve, reject) => {
			const e = this._onEmoteOnlyResult((_channel, error) => {
				if (toUserName(_channel) === channel) {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
					this.removeListener(e);
				}
			});
			this.say(channel, '/emoteonly');
		});
	}

	/**
	 * Disables emote-only mode in a channel.
	 *
	 * @param channel The channel to disable emote-only mode in.
	 */
	async disableEmoteOnly(channel: string) {
		channel = toUserName(channel);
		return new Promise<void>((resolve, reject) => {
			const e = this._onEmoteOnlyOffResult((_channel, error) => {
				if (toUserName(_channel) === channel) {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
					this.removeListener(e);
				}
			});
			this.say(channel, '/emoteonlyoff');
		});
	}

	/**
	 * Enables followers-only mode in a channel.
	 *
	 * @param channel The channel to enable followers-only mode in.
	 * @param delay The time (in minutes) a user needs to be following before being able to send messages.
	 */
	async enableFollowersOnly(channel: string, delay: number = 0) {
		channel = toUserName(channel);
		return new Promise<void>((resolve, reject) => {
			const e = this._onFollowersOnlyResult((_channel, _delay, error) => {
				if (toUserName(_channel) === channel && _delay === delay) {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
					this.removeListener(e);
				}
			});
			this.say(channel, `/followers ${delay || ''}`);
		});
	}

	/**
	 * Disables followers-only mode in a channel.
	 *
	 * @param channel The channel to disable followers-only mode in.
	 */
	async disableFollowersOnly(channel: string) {
		channel = toUserName(channel);
		return new Promise<void>((resolve, reject) => {
			const e = this._onFollowersOnlyOffResult((_channel, error) => {
				if (toUserName(_channel) === channel) {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
					this.removeListener(e);
				}
			});
			this.say(channel, '/followersoff');
		});
	}

	/**
	 * Gives a user moderator rights in a channel.
	 *
	 * @param channel The channel to give the user moderator rights in.
	 * @param user The user to give moderator rights.
	 */
	async mod(channel: string, user: string) {
		channel = toUserName(channel);
		user = toUserName(user);
		return new Promise<void>((resolve, reject) => {
			const e = this._onModResult((_channel, _user, error) => {
				if (toUserName(_channel) === channel && toUserName(_user) === user) {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
					this.removeListener(e);
				}
			});
			this.say(channel, `/mod ${user}`);
		});
	}

	/**
	 * Takes moderator rights from a user in a channel.
	 *
	 * @param channel The channel to remove the user's moderator rights in.
	 * @param user The user to take moderator rights from.
	 */
	async unmod(channel: string, user: string) {
		channel = toUserName(channel);
		user = toUserName(user);
		return new Promise<void>((resolve, reject) => {
			const e = this._onUnmodResult((_channel, _user, error) => {
				if (toUserName(_channel) === channel && toUserName(_user) === user) {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
					this.removeListener(e);
				}
			});
			this.say(channel, `/unmod ${user}`);
		});
	}

	/**
	 * Retrieves a list of moderators in a channel.
	 *
	 * @param channel The channel to retrieve the moderators of.
	 */
	async getMods(channel: string) {
		channel = toUserName(channel);
		return new Promise<string[]>(resolve => {
			const e = this._onModsResult((_channel, mods) => {
				if (toUserName(_channel) === channel) {
					resolve(mods);
					this.removeListener(e);
				}
			});
			this.say(channel, '/mods');
		});
	}

	/**
	 * Enables r9k mode in a channel.
	 *
	 * @param channel The channel to enable r9k mode in.
	 */
	async enableR9k(channel: string) {
		channel = toUserName(channel);
		return new Promise<void>((resolve, reject) => {
			const e = this._onR9kResult((_channel, error) => {
				if (toUserName(_channel) === channel) {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
					this.removeListener(e);
				}
			});
			this.say(channel, '/r9kbeta');
		});
	}

	/**
	 * Disables r9k mode in a channel.
	 *
	 * @param channel The channel to disable r9k mode in.
	 */
	async disableR9k(channel: string) {
		channel = toUserName(channel);
		return new Promise<void>((resolve, reject) => {
			const e = this._onR9kOffResult((_channel, error) => {
				if (toUserName(_channel) === channel) {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
					this.removeListener(e);
				}
			});
			this.say(channel, '/r9kbetaoff');
		});
	}

	/**
	 * Enables slow mode in a channel.
	 *
	 * @param channel The channel to enable slow mode in.
	 * @param delay The time (in seconds) a user needs to wait between messages.
	 */
	async enableSlow(channel: string, delay: number) {
		channel = toUserName(channel);
		return new Promise<void>((resolve, reject) => {
			const e = this._onSlowResult((_channel, error) => {
				if (toUserName(_channel) === channel) {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
					this.removeListener(e);
				}
			});
			this.say(channel, '/slow');
		});
	}

	/**
	 * Disables slow mode in a channel.
	 *
	 * @param channel The channel to disable slow mode in.
	 */
	async disableSlow(channel: string) {
		channel = toUserName(channel);
		return new Promise<void>((resolve, reject) => {
			const e = this._onSlowOffResult((_channel, error) => {
				if (toUserName(_channel) === channel) {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
					this.removeListener(e);
				}
			});
			this.say(channel, '/slowoff');
		});
	}

	/**
	 * Enables subscribers-only mode in a channel.
	 *
	 * @param channel The channel to enable subscribers-only mode in.
	 */
	async enableSubsOnly(channel: string) {
		channel = toUserName(channel);
		return new Promise<void>((resolve, reject) => {
			const e = this._onSubsOnlyResult((_channel, error) => {
				if (toUserName(_channel) === channel) {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
					this.removeListener(e);
				}
			});
			this.say(channel, '/subscribers');
		});
	}

	/**
	 * Disables subscribers-only mode in a channel.
	 *
	 * @param channel The channel to disable subscribers-only mode in.
	 */
	async disableSubsOnly(channel: string) {
		channel = toUserName(channel);
		return new Promise<void>((resolve, reject) => {
			const e = this._onSubsOnlyOffResult((_channel, error) => {
				if (toUserName(_channel) === channel) {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
					this.removeListener(e);
				}
			});
			this.say(channel, '/subscribersoff');
		});
	}

	/**
	 * Times out a user in a channel and removes all their messages.
	 *
	 * @param channel The channel to time out the user in.
	 * @param user The user to time out.
	 * @param duration The time (in seconds) until the user can send messages again. Defaults to 1 minute.
	 * @param reason
	 */
	async timeout(channel: string, user: string, duration: number = 60, reason: string = '') {
		channel = toUserName(channel);
		return new Promise<void>((resolve, reject) => {
			const e = this._onTimeoutResult((_channel, _user, error) => {
				if (toUserName(_channel) === channel && toUserName(_user) === user) {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
					this.removeListener(e);
				}
			});
			this.say(channel, `/timeout ${user} ${duration} ${reason}`);
		});
	}

	/**
	 * Removes all messages of a user from a channel.
	 *
	 * @param channel The channel to purge the user's messages from.
	 * @param user The user to purge.
	 * @param reason The reason for the purge.
	 */
	async purge(channel: string, user: string, reason: string = '') {
		return this.timeout(channel, user, 1, reason);
	}

	/**
	 * Gives a user VIP status in a channel.
	 *
	 * @param channel The channel to give the user VIP status in.
	 * @param user The user to give VIP status.
	 */
	async addVIP(channel: string, user: string) {
		channel = toUserName(channel);
		user = toUserName(user);
		return new Promise<void>((resolve, reject) => {
			const e = this._onVipResult((_channel, _user, error) => {
				if (toUserName(_channel) === channel && toUserName(_user) === user) {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
					this.removeListener(e);
				}
			});
			this.say(channel, `/vip ${user}`);
		});
	}

	/**
	 * Takes VIP status from a user in a channel.
	 *
	 * @param channel The channel to remove the user's VIP status in.
	 * @param user The user to take VIP status from.
	 */
	async removeVIP(channel: string, user: string) {
		channel = toUserName(channel);
		user = toUserName(user);
		return new Promise<void>((resolve, reject) => {
			const e = this._onUnvipResult((_channel, _user, error) => {
				if (toUserName(_channel) === channel && toUserName(_user) === user) {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
					this.removeListener(e);
				}
			});
			this.say(channel, `/unvip ${user}`);
		});
	}

	/**
	 * Retrieves a list of moderators in a channel.
	 *
	 * @param channel The channel to retrieve the moderators of.
	 */
	async getVIPs(channel: string) {
		channel = toUserName(channel);
		return new Promise<string[]>(resolve => {
			const e = this._onVipsResult((_channel, vips) => {
				if (toUserName(_channel) === channel) {
					resolve(vips);
					this.removeListener(e);
				}
			});
			this.say(channel, '/vips');
		});
	}

	/**
	 * Sends a message to a channel.
	 *
	 * @param channel The channel to send the message to.
	 * @param message The message to send.
	 */
	say(channel: string, message: string) {
		super.say(toChannelName(channel), message);
	}

	/**
	 * Sends an action message (/me) to a channel.
	 *
	 * @param channel The channel to send the message to.
	 * @param message The message to send.
	 */
	action(channel: string, message: string) {
		super.action(toChannelName(channel), message);
	}

	/**
	 * Sends a whisper message to another user.
	 *
	 * @param user The user to send the message to.
	 * @param message The message to send.
	 */
	whisper(user: string, message: string) {
		super.say(GENERIC_CHANNEL, `/w ${toUserName(user)} ${message}`);
	}

	/**
	 * Joins a channel.
	 *
	 * @param channel The channel to join.
	 */
	async join(channel: string) {
		channel = toChannelName(channel);
		return new Promise<void>((resolve, reject) => {
			let timer: NodeJS.Timer;
			const e = this._onJoinResult((chan, state, error) => {
				if (chan === channel) {
					clearTimeout(timer);
					if (error) {
						reject(error);
					} else {
						resolve();
					}
					this.removeListener(e);
				}
			});
			timer = setTimeout(() => {
				this.removeListener(e);
				reject(new Error(`Did not receive a reply to join ${channel} in time; assuming that the join failed`));
			}, 10000);
			super.join(channel);
		});
	}

	/**
	 * Disconnects from the chat server.
	 */
	async quit() {
		return new Promise<void>(resolve => {
			if (this._connection) {
				const thatConnection = this._connection;
				const handler = () => {
					thatConnection.removeListener('disconnect', handler);
					resolve();
				};
				thatConnection.addListener('disconnect', handler);
				thatConnection.disconnect();
			}
		});
	}

	/**
	 * Waits for authentication (or "registration" in IRC terms) to finish.
	 *
	 * @deprecated Use the `onRegister` event instead.
	 */
	async waitForRegistration() {
		if (this._registered) {
			return;
		}

		if (this._authFailureMessage) {
			throw new Error(`Registration failed. Response from Twitch: ${this._authFailureMessage}`);
		}

		let authListener: Listener | undefined;
		try {
			await Promise.race([
				new Promise<never>((resolve, reject) => {
					authListener = this.onAuthenticationFailure(message => {
						reject(Error(`Registration failed. Response from Twitch: ${message}`));
					});
				}),
				super.waitForRegistration()
			]);
		} finally {
			if (authListener) {
				this.removeListener(authListener);
			}
		}
	}

	protected registerCoreMessageTypes() {
		super.registerCoreMessageTypes();
		this.registerMessageType(TwitchPrivateMessage);
	}

	protected async getPassword(currentPassword?: string): Promise<string | undefined> {
		if (!this._twitchClient) {
			return undefined;
		}

		if (currentPassword && this._authVerified) {
			this._chatLogger.debug2('Password assumed to be correct from last connection');
			return currentPassword;
		}

		let scopes: string[];
		if (this._useLegacyScopes) {
			scopes = ['chat_login'];
		} else if (this._readOnly) {
			scopes = ['chat:read'];
		} else {
			scopes = ['chat:read', 'chat:edit'];
		}

		try {
			const accessToken = await this._twitchClient.getAccessToken(scopes);
			if (accessToken) {
				const token = await this._twitchClient.getTokenInfo();
				if (token.valid) {
					this._updateCredentials({
						nick: token.userName!
					});
					return `oauth:${accessToken.accessToken}`;
				}
			}
		} catch (e) {
			this._chatLogger.err(`Retrieving an access token failed: ${e.message}`);
		}

		this._chatLogger.warning('No valid token available; trying to refresh');

		try {
			const newToken = await this._twitchClient.refreshAccessToken();

			if (newToken) {
				const token = await this._twitchClient.getTokenInfo();
				if (token.valid) {
					this._updateCredentials({
						nick: token.userName!
					});
					return `oauth:${newToken.accessToken}`;
				}
			}
		} catch (e) {
			this._chatLogger.err(`Refreshing the access token failed: ${e.message}`);
		}

		this._authVerified = false;
		throw new Error('Could not retrieve a valid token');
	}

	private static _generateJustinfanNick() {
		const randomSuffix = Math.floor(Math.random() * 100000)
			.toString()
			.padStart(5, '0');
		return `justinfan${randomSuffix}`;
	}
}

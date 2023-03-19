import { randomUUID } from 'crypto'
import { orderBy } from 'lodash'
import { CookieJar } from 'tough-cookie'
import { texts, PlatformAPI, OnServerEventCallback, LoginResult, Paginated, Thread, Message, CurrentUser, InboxName, MessageContent, PaginationArg, MessageSendOptions, SerializedSession, ServerEventType, ActivityType, MessageID, ReAuthError, ThreadFolderName, LoginCreds } from '@textshq/platform-sdk'
import { tryParseJSON } from '@textshq/platform-sdk/dist/json'
import type { IncomingMessage } from 'http'
import type EventEmitter from 'events'

import OpenAIAPI from './network-api'
import { mapMessage, mapThread, participants } from './mappers'

const DEFAULT_THREAD_ID = 'chatgpt'
export default class OpenAI implements PlatformAPI {
  private currentUser: CurrentUser

  private genDefaultThread = () => {
    const t: Thread = {
      id: DEFAULT_THREAD_ID,
      type: 'single',
      timestamp: new Date(),
      description: 'Send /reset or /clear to reset the conversation.',
      messages: {
        items: [...this.messages.values()],
        hasMore: false,
      },
      participants,
      isUnread: false,
      isReadOnly: false,
    }
    return t
  }

  private messages = new Map<MessageID, Message>()

  private defaultConvID: string

  private pushEvent: OnServerEventCallback

  private api = new OpenAIAPI()

  init = async (session: SerializedSession) => {
    if (!session) return
    const { jar, ua, authMethod } = session
    this.api.jar = CookieJar.fromJSON(jar)
    this.api.ua = ua
    this.api.authMethod = authMethod
    await this.fetchSession()
  }

  login = async ({ cookieJarJSON, jsCodeResult }: LoginCreds): Promise<LoginResult> => {
    if (!cookieJarJSON) return { type: 'error', errorMessage: 'Cookies not found' }
    if (jsCodeResult) {
      const { ua, authMethod } = JSON.parse(jsCodeResult)
      this.api.ua = ua
      this.api.authMethod = authMethod || 'login-window'
    }
    this.api.jar = CookieJar.fromJSON(cookieJarJSON as any)
    await this.fetchSession()
    return { type: 'success' }
  }

  serializeSession = () => ({
    jar: this.api.jar.toJSON(),
    ua: this.api.ua,
    authMethod: this.api.authMethod ?? 'login-window',
  })

  logout = () => {}

  dispose = () => {}

  private fetchSession = async (refreshing = false) => {
    texts.log('fetching session', { refreshing })
    const json = await this.api.session()
    const { user, accessToken, expires, error } = json
    this.currentUser = {
      id: user.id,
      fullName: user.name,
      email: user.email,
      imgURL: user.image,
      displayText: user.name,
    }
    if (error === 'RefreshAccessTokenError') throw new ReAuthError()
    // const dist = new Date(expires).getTime() - Date.now()
    // console.log(new Date(expires), dist)
    // setTimeout(this.fetchSession, new Date(expires).getTime() - Date.now(), true)
  }

  getCurrentUser = () => this.currentUser

  subscribeToEvents = (onEvent: OnServerEventCallback) => {
    this.pushEvent = onEvent
  }

  getThread = async (threadID: string) => {
    const conv = await this.api.conversation(threadID)
    return mapThread(conv, this.currentUser.id)
  }

  getThreads = async (inboxName: ThreadFolderName, pagination: PaginationArg) => {
    if (inboxName === InboxName.REQUESTS) {
      return { items: [], hasMore: false }
    }
    const conv = await this.api.conversations(pagination ? +pagination.cursor : undefined)
    const items = (conv.items as any[]).map(t => mapThread(t, this.currentUser.id))
    if (!pagination?.cursor) items.unshift(this.genDefaultThread())
    return {
      items,
      hasMore: conv.items.length === conv.limit,
      oldestCursor: conv.offset + conv.limit,
    }
  }

  getMessages = async (threadID: string, pagination: PaginationArg): Promise<Paginated<Message>> => {
    if (threadID === DEFAULT_THREAD_ID) {
      return {
        items: orderBy([...this.messages.values()], 'timestamp'),
        hasMore: false,
      }
    }
    const conv = await this.api.conversation(threadID)
    const items = Object.values(conv.mapping)
      .map(m => mapMessage(m, this.currentUser.id))
      .filter(Boolean)
    return {
      items,
      hasMore: false,
    }
  }

  sendMessage = async (threadID: string, content: MessageContent, options: MessageSendOptions) => {
    if (!content.text) return false
    if (['/clear', '/reset'].includes(content.text)) {
      this.defaultConvID = undefined
      this.messages.clear()
      this.pushEvent([{
        type: ServerEventType.STATE_SYNC,
        objectName: 'message',
        mutationType: 'delete-all',
        objectIDs: { threadID },
      }])
      return true
    }
    const userMessage: Message = {
      id: options.pendingMessageID,
      timestamp: new Date(),
      text: content.text,
      senderID: this.currentUser.id,
      isSender: true,
    }
    this.pushEvent([{
      type: ServerEventType.USER_ACTIVITY,
      activityType: ActivityType.CUSTOM,
      customLabel: 'thinking',
      threadID,
      participantID: 'chatgpt',
      durationMs: 30_000,
    }])
    const stream = await this.api.postMessage(threadID === DEFAULT_THREAD_ID ? this.defaultConvID : threadID, options.pendingMessageID, content.text, [...this.messages.values()].at(-1)?.id || randomUUID())
    this.messages.set(userMessage.id, userMessage)
    let response: IncomingMessage
    (stream as EventEmitter).on('response', (res: IncomingMessage) => {
      response = res
    })
    stream.on('data', (chunk: Buffer) => {
      const string = chunk.toString()
      // texts.log(string)
      if (string === '[DONE]') return
      const ct = response.headers['content-type']
      if (!ct.includes('text/event-stream')) {
        // 401 application/json {"detail":{"message":"Your authentication token has expired. Please try signing in again.","type":"invalid_request_error","param":null,"code":"token_expired"}}
        texts.log(response.statusCode, ct, string)
        const json = string.startsWith('<') ? string : JSON.parse(string)
        const msg: Message = {
          id: randomUUID(),
          timestamp: new Date(),
          text: json.detail?.message ?? json.detail ?? string,
          isAction: true,
          senderID: 'none',
        }
        if (typeof msg.text !== 'string') msg.text = string
        this.pushEvent([{
          type: ServerEventType.USER_ACTIVITY,
          activityType: ActivityType.NONE,
          threadID,
          participantID: 'chatgpt',
        }, {
          type: ServerEventType.STATE_SYNC,
          objectName: 'message',
          mutationType: 'upsert',
          objectIDs: { threadID },
          entries: [msg],
        }])
        return
      }
      const parsed = string
        .split('data: ')
        .map(l => l.trim())
        .filter(Boolean)
        .map(l => tryParseJSON(l))
        .filter(Boolean)
      if (threadID === DEFAULT_THREAD_ID && parsed[0]) this.defaultConvID = parsed[0].conversation_id
      const entries = parsed.map<Message>(m => mapMessage(m, this.currentUser.id)).filter(Boolean)
      if (!entries.length) return
      this.pushEvent([{
        type: ServerEventType.STATE_SYNC,
        objectName: 'message',
        mutationType: 'upsert',
        objectIDs: { threadID },
        entries,
      }])
      entries.forEach(e => {
        this.messages.set(e.id, e)
      })
    })
    stream.on('end', (chunk: Buffer) => {
      const string = chunk?.toString()
      // texts.log('end', string)
    })
    return [userMessage]
  }

  deleteThread = async (threadID: string) => {
    const json = await this.api.patchConversation(threadID, { is_visible: false })
    if (!json.success) throw Error(JSON.stringify(json))
  }

  sendActivityIndicator = (threadID: string) => {}

  sendReadReceipt = async (threadID: string, messageID: string) => {}
}

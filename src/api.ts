import { randomUUID } from 'crypto'
import { orderBy } from 'lodash'
import { CookieJar } from 'tough-cookie'
import { texts, PlatformAPI, OnServerEventCallback, LoginResult, Paginated, Thread, Message, CurrentUser, InboxName, MessageContent, PaginationArg, MessageSendOptions, SerializedSession, ServerEventType, ActivityType, MessageID, TextAttributes, TextEntity, MessageBehavior, ReAuthError } from '@textshq/platform-sdk'
import { tryParseJSON } from '@textshq/platform-sdk/dist/json'
import type { IncomingMessage } from 'http'
import type { EventEmitter } from 'stream'

const ENDPOINT = 'https://chat.openai.com/'

const OPENAI_SVG_DATA_URI = 'data:image/svg+xml;utf8,<svg width="1em" height="1em" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M14.949 6.547a3.938 3.938 0 00-.348-3.273 4.108 4.108 0 00-4.4-1.934A4.105 4.105 0 008.423.2 4.153 4.153 0 006.305.086a4.12 4.12 0 00-1.891.948 4.039 4.039 0 00-1.158 1.753 4.073 4.073 0 00-1.563.679A4.009 4.009 0 00.554 4.72a3.988 3.988 0 00.502 4.731 3.936 3.936 0 00.346 3.274 4.11 4.11 0 004.402 1.933c.382.425.852.764 1.377.995a4.093 4.093 0 001.67.346c1.78.002 3.358-1.132 3.901-2.804a4.077 4.077 0 001.563-.68 4.012 4.012 0 001.14-1.253 3.994 3.994 0 00-.506-4.716zm-6.098 8.406a3.05 3.05 0 01-1.944-.694l.096-.054 3.23-1.838a.534.534 0 00.265-.455v-4.49l1.366.778a.048.048 0 01.025.035v3.722c-.003 1.653-1.361 2.992-3.037 2.996zm-6.529-2.75a2.946 2.946 0 01-.361-2.01l.096.057L5.29 12.09a.527.527 0 00.527 0l3.949-2.246v1.555a.053.053 0 01-.022.041L6.473 13.3c-1.454.826-3.311.335-4.15-1.098zm-.85-6.94A3.022 3.022 0 013.07 3.95v3.784a.506.506 0 00.262.451l3.93 2.237-1.366.779a.051.051 0 01-.048 0L2.585 9.342a2.98 2.98 0 01-1.113-4.094v.016zm11.216 2.571L8.746 5.576l1.362-.776a.052.052 0 01.048 0l3.265 1.861c.499.284.906.703 1.173 1.206a2.961 2.961 0 01-.27 3.2c-.349.452-.82.798-1.36.997V8.279a.521.521 0 00-.276-.445zm1.36-2.015l-.097-.057-3.226-1.854a.53.53 0 00-.53 0L6.248 6.153V4.598a.044.044 0 01.019-.04l3.265-1.859a3.074 3.074 0 013.257.14c.474.325.844.778 1.066 1.303.223.526.29 1.103.191 1.664v.013zM5.503 8.575L4.138 7.8a.054.054 0 01-.025-.038V4.049c0-.569.166-1.127.476-1.607.31-.48.752-.863 1.275-1.105a3.078 3.078 0 013.234.41l-.096.054-3.23 1.838a.534.534 0 00-.265.455l-.003 4.481zm.742-1.577l1.758-1 1.762 1v2l-1.755 1-1.762-1-.003-2z" fill="currentColor"/></svg>'

function parseTextAttributes(text: string): TextAttributes {
  const toScalarIndex = (idx: number) => Array.from(text.substring(0, idx)).length

  const regex = /```\n([^]+?)\n```/g
  const entities: TextEntity[] = []
  const matches = text.matchAll(regex)
  for (const match of matches) {
    const from = toScalarIndex(match.index)
    const to = toScalarIndex(match.index + match[0].length)
    entities.push({
      from,
      to,
      code: true,
      pre: true,
      codeLanguage: 'auto',
    })
    entities.push({
      from,
      to: from + 4,
      replaceWith: '',
    })
    entities.push({
      from: to - 3,
      to,
      replaceWith: '',
    })
  }
  if (!entities.length) return
  return { entities }
}

const headers = {
  'x-openai-assistant-app-id': '',
  'accept-language': 'en-US,en;q=0.9',
  origin: 'https://chat.openai.com',
  referer: 'https://chat.openai.com/chat',
  'sec-ch-ua':
    '"Not?A_Brand";v="8", "Chromium";v="108", "Google Chrome";v="108"',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
}

export default class OpenAI implements PlatformAPI {
  private currentUser: CurrentUser

  private accessToken: string

  private genThread = () => {
    const t: Thread = {
      id: 'chatgpt',
      type: 'single',
      timestamp: new Date(),
      description: 'Send /reset or /clear to reset the conversation.',
      messages: {
        items: [...this.messages.values()],
        hasMore: false,
      },
      participants: {
        hasMore: false,
        items: [
          {
            id: 'chatgpt',
            fullName: 'ChatGPT',
            imgURL: OPENAI_SVG_DATA_URI,
          },
          this.currentUser,
        ],
      },
      isUnread: false,
      isReadOnly: false,
    }
    return t
  }

  private userAgent: string = texts.constants.USER_AGENT

  private jar: CookieJar

  private http = texts.createHttpClient()

  private messages = new Map<MessageID, Message>()

  private convID: string

  private pushEvent: OnServerEventCallback

  init = (session: SerializedSession) => {
    if (session?.jar) this.jar = CookieJar.fromJSON(session)
    if (session?.userAgent) this.userAgent = session.userAgent
    if (session?.accessToken) this.accessToken = session.accessToken
  }

  login = async ({ cookieJarJSON, jsCodeResult }): Promise<LoginResult> => {
    if (!cookieJarJSON) return { type: 'error', errorMessage: 'Cookies not found' }

    this.jar = CookieJar.fromJSON(cookieJarJSON)

    if (jsCodeResult?.userAgent) {
      this.userAgent = jsCodeResult.userAgent
    }

    if (jsCodeResult?.accessToken) {
      this.accessToken = jsCodeResult.accessToken
    }

    return { type: 'success' }
  }

  serializeSession = () => ({
    jar: this.jar.toJSON(),
    userAgent: this.userAgent,
    accessToken: this.accessToken,
  })

  logout = () => {}

  dispose = () => {}

  private fetchSession = async (refreshing = false) => {
    texts.log('fetching session', { refreshing })
    const res = await this.http.requestAsString(`${ENDPOINT}api/auth/session`, {
      headers: {
        ...headers,
        'user-agent': this.userAgent,
      },
      cookieJar: this.jar,
    })
    if (res.body[0] === '<') {
      console.log(res.statusCode, res.body)
      const [, title] = /<title[^>]*>(.*?)<\/title>/.exec(res.body) || []
      throw Error(`expected json, got html, status code=${res.statusCode}, title=${title}`)
    }
    const json = JSON.parse(res.body)
    texts.log(json)
    const { user, accessToken, expires, error } = json
    this.accessToken = accessToken
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

  getCurrentUser = async (): Promise<CurrentUser> => {
    await this.fetchSession()
    return this.currentUser
  }

  subscribeToEvents = (onEvent: OnServerEventCallback) => {
    this.pushEvent = onEvent
  }

  getThreads = (inboxName: InboxName) => {
    if (inboxName === InboxName.REQUESTS) {
      return {
        items: [],
        hasMore: false,
      }
    }
    return {
      items: [this.genThread()],
      hasMore: false,
      oldestCursor: undefined,
    }
  }

  getMessages = async (threadID: string, pagination: PaginationArg): Promise<Paginated<Message>> => ({
    items: orderBy([...this.messages.values()], 'timestamp'),
    hasMore: false,
  })

  sendMessage = async (threadID: string, content: MessageContent, options: MessageSendOptions) => {
    if (!content.text) return false
    if (['/clear', '/reset'].includes(content.text)) {
      this.convID = undefined
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
    const stream = await texts.fetchStream(`${ENDPOINT}backend-api/conversation`, {
      method: 'POST',
      cookieJar: this.jar,
      headers: {
        ...headers,
        Accept: 'text/event-stream',
        'Accept-Language': 'en',
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        'user-agent': this.userAgent,
      },
      body: JSON.stringify({
        action: 'next',
        conversation_id: this.convID,
        messages: [{ id: options.pendingMessageID, role: 'user', content: { content_type: 'text', parts: [content.text] } }],
        model: 'text-davinci-002-render',
        parent_message_id: [...this.messages.values()].at(-1)?.id || randomUUID(),
      }),
    })
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
      if (parsed[0]) this.convID = parsed[0].conversation_id
      const timestamp = new Date()
      const entries = parsed.map<Message>(m => {
        const text = m.message.content?.parts.join('\n')
        return {
          _original: JSON.stringify(m),
          id: m.message.id,
          senderID: 'chatgpt',
          text: m.message.content?.parts.join('\n'),
          textAttributes: parseTextAttributes(text),
          timestamp,
          behavior: MessageBehavior.DONT_NOTIFY,
        }
      }).filter(m => m.text)
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

  sendActivityIndicator = (threadID: string) => {}

  deleteMessage = async (threadID: string, messageID: string) => {}

  sendReadReceipt = async (threadID: string, messageID: string) => {}
}

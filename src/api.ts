import { randomUUID } from 'crypto'
import { CookieJar } from 'tough-cookie'
import { texts, PlatformAPI, OnServerEventCallback, LoginResult, Paginated, Message, CurrentUser, InboxName, MessageContent, PaginationArg, MessageSendOptions, SerializedSession, ServerEventType, ActivityType, ReAuthError, ThreadFolderName, LoginCreds, ThreadID, UserID, MessageID } from '@textshq/platform-sdk'
import { tryParseJSON } from '@textshq/platform-sdk/dist/json'
import type { IncomingMessage } from 'http'
import type EventEmitter from 'events'

import OpenAIAPI from './network-api'
import { Plugin, Model } from './interfaces'
import { mapMessage, mapModel, mapThread } from './mappers'

const DEFAULT_MODEL = 'text-davinci-002-render-sha'

export default class OpenAI implements PlatformAPI {
  private currentUser: CurrentUser

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
    // if (texts.IS_DEV) {
    //   const cookie = this.api.jar.getCookieStringSync('https://chat.openai.com/api/auth/session')
    //   console.log({ cookie })
    // }
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

  private modelsResPromise: Promise<{ models: Model[] }>

  private pluginsPromise: Promise<{ count: number, items: Plugin[] }>

  private fetchSession = async (refreshing = false) => {
    texts.log('fetching session', { refreshing })
    const json = await this.api.session()
    const { user, accessToken, expires, error } = json
    if (error === 'RefreshAccessTokenError') throw new ReAuthError()
    if (!user) {
      console.log(json)
      throw Error('no user')
    }
    this.api.accountsCheck().then(texts.log)
    this.modelsResPromise = this.api.models()
    this.pluginsPromise = this.api.plugins()
    this.modelsResPromise.then(res => texts.log(JSON.stringify(res, null, 2)))
    // this.pluginsPromise.then(res => texts.log(JSON.stringify(res, null, 2)))
    this.currentUser = {
      id: user.id,
      fullName: user.name,
      email: user.email,
      imgURL: user.image,
      displayText: user.name,
    }
    // const dist = new Date(expires).getTime() - Date.now()
    // console.log(new Date(expires), dist)
    // setTimeout(this.fetchSession, new Date(expires).getTime() - Date.now(), true)
  }

  getCurrentUser = () => this.currentUser

  searchUsers = async () => (await this.modelsResPromise).models.map(mapModel)

  createThread = async (userIDs: UserID[], title: string, message: string) => {
    const modelID = userIDs[0]
    const model = (await this.modelsResPromise).models.find(m => m.slug === modelID)
    const pluginIDs = model.enabled_tools
      ? (await this.pluginsPromise).items.map(i => i.id)
      : undefined
    const threadID = await new Promise<string>(resolve => {
      this.postMessage({
        model: modelID,
        guid: randomUUID(),
        parentMessageID: randomUUID(),
        text: message,
        pluginIDs,
        conversationID: undefined,
      }, tid => resolve(tid))
    })
    if (!threadID) throw Error('unknown')
    return this.getThread(threadID)
  }

  subscribeToEvents = (onEvent: OnServerEventCallback) => {
    this.pushEvent = onEvent
  }

  getThread = async (threadID: ThreadID) => {
    const conv = await this.api.conversation(threadID)
    return mapThread(conv, this.currentUser.id, threadID)
  }

  getThreads = async (inboxName: ThreadFolderName, pagination: PaginationArg) => {
    if (inboxName === InboxName.REQUESTS) {
      return { items: [], hasMore: false }
    }
    const conv = await this.api.conversations(pagination ? +pagination.cursor : undefined)
    const items = (conv.items as any[]).map(t => mapThread(t, this.currentUser.id))
    return {
      items,
      hasMore: conv.items.length === conv.limit,
      oldestCursor: conv.offset + conv.limit,
    }
  }

  private updatedDescriptionSet = new Set<string>()

  getMessages = async (threadID: string, pagination: PaginationArg): Promise<Paginated<Message>> => {
    const conv = await this.api.conversation(threadID)
    if (!conv.mapping) return { items: [], hasMore: true }
    const items = Object.values(conv.mapping)
      .map(m => mapMessage(m, this.currentUser.id))
      .filter(Boolean)
    const lastMessage = items.at(-1)
    if (lastMessage && !this.updatedDescriptionSet.has(threadID)) {
      const model = (await this.modelsResPromise).models.find(m => m.slug === lastMessage.extra.modelSlug)
      if (model) {
        const plugins = conv.plugin_ids
          ? await Promise.all(conv.plugin_ids.map(async pid => (await this.pluginsPromise).items.find(i => i.id === pid)))
          : undefined
        const pluginNames = plugins?.map(p => p.manifest.name_for_human).filter(Boolean).join(', ')
        this.pushEvent([{
          type: ServerEventType.STATE_SYNC,
          mutationType: 'update',
          objectName: 'thread',
          objectIDs: {},
          entries: [{
            id: threadID,
            description: `Model: ${model.title} (${model.slug})${pluginNames ? `\nEnabled plugins: ${pluginNames}` : ''}`,
          }],
        }])
        this.updatedDescriptionSet.add(threadID)
      }
    }
    return {
      items,
      hasMore: false,
    }
  }

  private handleSendError = (response: IncomingMessage, ct: string, string: string, convID: string | undefined) => {
    // 401 application/json {"detail":{"message":"Your authentication token has expired. Please try signing in again.","type":"invalid_request_error","param":null,"code":"token_expired"}}
    // 500 application/json {"detail":"Error getting system message: Invalid variable type: value should be str, int or float, got None of type <class 'NoneType'>"}
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
    if (convID) {
      this.pushEvent([{
        type: ServerEventType.USER_ACTIVITY,
        activityType: ActivityType.NONE,
        threadID: convID,
        participantID: 'chatgpt',
      }, {
        type: ServerEventType.STATE_SYNC,
        objectName: 'message',
        mutationType: 'upsert',
        objectIDs: { threadID: convID },
        entries: [msg],
      }])
    } else {
      this.pushEvent([{
        type: ServerEventType.TOAST,
        toast: { text: msg.text, timeoutMs: -1 },
      }])
    }
  }

  private postMessage = async ({ model, conversationID, guid, text, parentMessageID, pluginIDs }: Parameters<typeof this.api.postMessage>[0], convIDCallback?: (threadID: ThreadID) => void) => {
    let convID = conversationID
    let calledConvIDCallback = false
    const stream = await this.api.postMessage({ model, conversationID: convID, guid, text, parentMessageID, pluginIDs })
    let response: IncomingMessage
    (stream as EventEmitter).on('response', (res: IncomingMessage) => {
      response = res
    })
    let messageID: MessageID
    stream.on('data', (chunk: Buffer) => {
      const string = chunk.toString()
      // texts.log(string)
      if (string === '[DONE]') return
      const ct = response.headers['content-type']
      if (!ct.includes('text/event-stream')) return this.handleSendError(response, ct, string, convID)
      const parsed = string
        .split('data: ')
        .map(l => l.trim())
        .filter(Boolean)
        .map(l => tryParseJSON(l))
        .filter(Boolean)
      const entries = parsed.map<Message>(m => mapMessage(m, this.currentUser.id)).filter(Boolean)
      if (!entries.length) return
      messageID = entries[0].id
      if (convID) {
        if (!calledConvIDCallback) {
          calledConvIDCallback = true
          convIDCallback?.(convID)
        }
        this.pushEvent([{
          type: ServerEventType.STATE_SYNC,
          objectName: 'message',
          mutationType: 'upsert',
          objectIDs: { threadID: convID },
          entries,
        }])
      } else {
        convID = parsed[0]?.conversation_id
      }
    })
    stream.on('end', async (chunk: Buffer) => {
      const string = chunk?.toString()
      // texts.log('postMessage end', string)
      if (!conversationID && messageID) {
        const { title } = await this.api.genTitle(convID, messageID)
        this.pushEvent([{
          type: ServerEventType.STATE_SYNC,
          objectName: 'thread',
          objectIDs: {},
          mutationType: 'update',
          entries: [{ id: convID, title }],
        }])
      }
    })
  }

  sendMessage = async (threadID: string, { text, filePath, fileName }: MessageContent, { pendingMessageID }: MessageSendOptions) => {
    if (!text && !filePath) return false
    const userMessage: Message = {
      id: pendingMessageID,
      timestamp: new Date(),
      text,
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
    const conv = await this.api.conversation(threadID)
    const lastMessage = Object.values(conv.mapping).at(-1)
    const model = lastMessage?.message?.metadata?.model_slug || DEFAULT_MODEL
    const parentMessageID = lastMessage?.id || randomUUID()
    if (filePath) {
      console.log('uploading', filePath)
      const res = await this.api.uploadFile(threadID, model, parentMessageID, filePath, fileName)
      console.log('upload res', res)
      if (res.detail) {
        this.pushEvent([{
          type: ServerEventType.USER_ACTIVITY,
          activityType: ActivityType.NONE,
          threadID,
          participantID: 'chatgpt',
        }])
        throw Error(JSON.stringify(res))
      }
    } else {
      await this.postMessage({ model, conversationID: threadID, guid: pendingMessageID, text, parentMessageID })
    }
    return [userMessage]
  }

  deleteThread = async (threadID: string) => {
    const json = await this.api.patchConversation(threadID, { is_visible: false })
    if (!json.success) throw Error(JSON.stringify(json))
  }

  sendActivityIndicator = (threadID: string) => {}

  sendReadReceipt = async (threadID: string, messageID: string) => {}
}

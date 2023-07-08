import fs from 'fs'
import { setTimeout } from 'timers/promises'
import { FetchOptions, RateLimitError, texts } from '@textshq/platform-sdk'
import { ExpectedJSONGotHTMLError } from '@textshq/platform-sdk/dist/json'
import { CookieJar } from 'tough-cookie'

import { ChatGPTConv } from './interfaces'
import { ELECTRON_UA, CLOSE_ON_AUTHENTICATED_JS } from './constants'
import type ChatGPT from './api'

const ENDPOINT = 'https://chat.openai.com/'

export default class OpenAIAPI {
  constructor(private readonly papi: ChatGPT) { }

  private http = texts.createHttpClient()

  jar: CookieJar

  ua = texts.constants.USER_AGENT

  authMethod: 'login-window' | 'extension' = 'login-window'

  private accessToken: string

  private cfChallengeInProgress: boolean

  private cfChallenge = async () => {
    this.cfChallengeInProgress = true
    console.log('cf challenge')
    console.time('cf challenge')
    try {
      // todo: add timeout or this will never resolve
      const result = await texts.openBrowserWindow(this.papi.accountID, {
        url: ENDPOINT,
        cookieJar: this.jar.toJSON(),
        userAgent: ELECTRON_UA,
        runJSOnLaunch: CLOSE_ON_AUTHENTICATED_JS,
        runJSOnNavigate: CLOSE_ON_AUTHENTICATED_JS,
      })
      if (!result.cookieJar) return
      this.ua = ELECTRON_UA
      const cj = CookieJar.fromJSON(result.cookieJar as any)
      this.jar = cj
      this.authMethod = 'login-window'
    } finally {
      console.timeEnd('cf challenge')
      this.cfChallengeInProgress = false
    }
  }

  private async call<ResultType = any>(pathname: string, jsonBody?: any, optOverrides?: Partial<FetchOptions>, attempt?: number): Promise<ResultType> {
    while (this.cfChallengeInProgress) {
      await setTimeout(100)
    }
    const isBackendAPI = pathname.startsWith('backend-api')
    if (isBackendAPI && !this.accessToken) throw Error('no accessToken')
    const opts: FetchOptions = {
      body: jsonBody ? JSON.stringify(jsonBody) : undefined,
      headers: {
        ...(isBackendAPI && { Authorization: `Bearer ${this.accessToken}` }),
        ...(jsonBody && { 'Content-Type': 'application/json' }),
        ...this.headers,
        Referer: 'https://chat.openai.com/',
      },
      cookieJar: this.jar,
      ...optOverrides,
    }
    const url = `${ENDPOINT}${pathname}`
    const res = await this.http.requestAsString(url, opts)
    if (res.statusCode === 429) throw new RateLimitError()
    if (res.body[0] === '<') {
      if (res.statusCode === 403 && !attempt) {
        await this.cfChallenge()
        return this.call<ResultType>(pathname, jsonBody, optOverrides, (attempt || 0) + 1)
      }
      if (res.statusCode >= 400) throw Error(`${url} returned status code ${res.statusCode}`)
      console.log(res.statusCode, url, res.body)
      throw new ExpectedJSONGotHTMLError(res.statusCode, res.body)
    } else if (res.body.startsWith('Internal')) {
      console.log(res.statusCode, url, res.body)
      throw Error(res.body)
    } else if (!res.body) {
      throw Error('falsey body')
    }
    const json = JSON.parse(res.body)
    if (json?.detail) { // potential error
      texts.error(url, json.detail)
    }
    return json as ResultType
  }

  async session() {
    const json = await this.call('api/auth/session')
    this.accessToken = json.accessToken
    return json
  }

  accountsCheck = () => this.call('backend-api/accounts/check/v4-2023-04-27')

  models = () => this.call('backend-api/models?history_and_training_disabled=' + Boolean(this.papi.historyAndTrainingDisabled))

  plugins = (offset = 0, limit = 20, isInstalled = true) =>
    this.call('backend-api/aip/p', undefined, { searchParams: { offset, limit, is_installed: String(isInstalled) } })

  conversations = (offset = 0, limit = 20) =>
    this.call<{
      items: ChatGPTConv[]
      total: number
      limit: number
      offset: number
      has_missing_conversations: boolean
    }>('backend-api/conversations', undefined, { searchParams: { offset, limit } })

  conversation = (id: string) =>
    this.call<ChatGPTConv>(`backend-api/conversation/${id}`)

  patchConversation = (id: string, body: any) =>
    this.call(`backend-api/conversation/${id}`, body, { method: 'PATCH' })

  genTitle = (convID: string, messageID: string) =>
    this.call(`backend-api/conversation/gen_title/${convID}`, { message_id: messageID }, { method: 'POST' })

  getUploadLink = (convID: string, filename: string, fileSize: number) =>
    this.call<{ upload_url: string }>('backend-api/conversation/get_upload_link', undefined, { method: 'POST', form: { conversation_id: convID, filename, file_size: fileSize } })

  uploadFile = (uploadLink: string, filePath: string) =>
    this.http.requestAsString(uploadLink, {
      method: 'PUT',
      body: fs.createReadStream(filePath),
      headers: {
        'x-ms-blob-type': 'BlockBlob',
        'x-ms-version': '2020-04-08',
      },
    })

  userUploadIsComplete = (convID: string, filename: string, model: string, parentMessageID: string) =>
    this.call<[{ conversation_id: string, error: any, message: any }] | { detail: any }>('backend-api/conversation/user_upload_is_complete', undefined, { method: 'POST', form: { conversation_id: convID, filename, model, parent_message_id: parentMessageID } })

  isUploadComplete = (filename: string) =>
    this.call<{ is_ready: boolean, retry: boolean }>('backend-api/conversation/is_upload_complete', undefined, { method: 'POST', form: { filename } })

  csrf = () =>
    this.call<{ csrfToken: string }>('api/auth/csrf')

  signout = async () => {
    const { csrfToken } = await this.csrf()
    return this.call('api/auth/signout', { csrfToken, callbackUrl: 'https://chat.openai.com/api/auth/logout', json: true }, { method: 'POST' })
  }

  logout = () =>
    this.call('api/auth/logout')

  get headers() {
    return {
      accept: '*/*',
      'accept-encoding': 'gzip, deflate',
      'accept-language': 'en',
      'sec-ch-ua': '"Not:A-Brand";v="99", "Chromium";v="112"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'sec-gpc': '1',
      'user-agent': this.ua,
    }
  }

  static generateMessage = (guid: string, text: string) => ({
    id: guid,
    author: { role: 'user' },
    role: 'user',
    content: { content_type: 'text', parts: [text] },
  })

  async postMessage({ model, conversationID, messages, pluginIDs, parentMessageID }: {
    model: string
    conversationID: string | undefined
    messages: any[]
    pluginIDs?: string[]
    parentMessageID: string
  }) {
    if (conversationID && pluginIDs) throw Error('set either conversationID or pluginIDs')
    const url = `${ENDPOINT}backend-api/conversation`
    const headers = {
      ...this.headers,
      accept: 'text/event-stream',
      authorization: `Bearer ${this.accessToken}`,
      'content-type': 'application/json',
      cookie: this.jar.getCookieStringSync(url),
      referer: conversationID ? `https://chat.openai.com/c/${conversationID}` : 'https://chat.openai.com/',
    }
    const body = {
      action: 'next',
      messages,
      conversation_id: conversationID,
      parent_message_id: parentMessageID,
      model,
      plugin_ids: pluginIDs,
      timezone_offset_min: new Date().getTimezoneOffset(),
      variant_purpose: 'none',
      history_and_training_disabled: this.papi.historyAndTrainingDisabled,
      arkose_token: null,
    }
    const stream = await texts.nativeFetchStream(null, url, {
      method: 'POST',
      cookieJar: this.jar,
      headers,
      body: JSON.stringify(body),
    })
    return stream
  }
}

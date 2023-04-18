import fs from 'fs'
import FormData from 'form-data'
import { FetchOptions, texts } from '@textshq/platform-sdk'
import { ExpectedJSONGotHTMLError } from '@textshq/platform-sdk/dist/json'
import type { CookieJar } from 'tough-cookie'

import { ChatGPTConv } from './interfaces'

const ENDPOINT = 'https://chat.openai.com/'

export default class OpenAIAPI {
  private http = texts.createHttpClient()

  jar: CookieJar

  ua = texts.constants.USER_AGENT

  authMethod: 'login-window' | 'extension' = 'login-window'

  private accessToken: string

  private async call<ResultType = any>(pathname: string, jsonBody?: any, optOverrides?: Partial<FetchOptions>) {
    const isBackendAPI = pathname.startsWith('backend-api')
    if (isBackendAPI && !this.accessToken) throw Error('no accessToken')
    const opts: FetchOptions = {
      body: jsonBody ? JSON.stringify(jsonBody) : undefined,
      headers: {
        ...(isBackendAPI && { Authorization: `Bearer ${this.accessToken}` }),
        ...(jsonBody && { 'Content-Type': 'application/json' }),
        Referer: 'https://chat.openai.com/chat',
        ...this.headers,
      },
      cookieJar: this.jar,
      ...optOverrides,
    }
    const url = `${ENDPOINT}${pathname}`
    const res = await this.http.requestAsString(url, opts)
    if (res.body[0] === '<') {
      console.log(res.statusCode, url, res.body)
      throw new ExpectedJSONGotHTMLError(res.statusCode, res.body)
    } else if (res.body.startsWith('Internal')) {
      console.log(res.statusCode, url, res.body)
      throw Error(res.body)
    }
    const json = JSON.parse(res.body)
    if (json.detail) { // potential error
      texts.error(url, json.detail)
    }
    return json as ResultType
  }

  async session() {
    const json = await this.call('api/auth/session')
    this.accessToken = json.accessToken
    return json
  }

  accountsCheck = () => this.call('backend-api/accounts/check')

  models = () => this.call('backend-api/models')

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

  uploadFile = async (convID: string, model: string, parentMessageID: string, filePath: string, fileName: string) => {
    const body = new FormData()
    body.append('conversation_id', convID)
    body.append('model', model)
    body.append('parent_message_id', parentMessageID)
    body.append('file', await fs.promises.readFile(filePath), { filename: fileName })
    return this.call('backend-api/conversation/upload', undefined, {
      body,
      method: 'POST',
    })
  }

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
      'accept-language': 'en',
      'sec-ch-ua': '"Google Chrome";v="112", "Not(A:Brand";v="8", "Chromium";v="112"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'user-agent': this.ua,
    }
  }

  async postMessage({ model, conversationID, guid, text, pluginIDs, parentMessageID }: {
    model: string
    conversationID: string | undefined
    guid: string
    text: string
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
      referer: conversationID ? `https://chat.openai.com/chat/${conversationID}` : 'https://chat.openai.com/chat',
    }
    const body = {
      action: 'next',
      messages: [{
        id: guid,
        author: { role: 'user' },
        role: 'user',
        content: { content_type: 'text', parts: [text] },
      }],
      conversation_id: conversationID,
      parent_message_id: parentMessageID,
      model,
      plugin_ids: pluginIDs,
      timezone_offset_min: new Date().getTimezoneOffset(),
    }
    const stream = await texts.fetchStream(url, {
      method: 'POST',
      cookieJar: this.jar,
      headers,
      body: JSON.stringify(body),
    })
    return stream
  }
}

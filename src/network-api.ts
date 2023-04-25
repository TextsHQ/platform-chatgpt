import fs from 'fs'
import { setTimeout } from 'timers/promises'
import FormData from 'form-data'
import { FetchOptions, texts } from '@textshq/platform-sdk'
import { ExpectedJSONGotHTMLError } from '@textshq/platform-sdk/dist/json'

import { ChatGPTConv } from './interfaces'
import { ELECTRON_UA, CLOSE_ON_AUTHENTICATED_JS } from './constants'
import type ChatGPT from './api'

const ENDPOINT = 'https://chat.openai.com/'

export const makeMutex = () => {
  let task = Promise.resolve() as Promise<any>
  return {
    mutex<T>(code: () => Promise<T>): Promise<T> {
      task = (async () => {
        // wait for the previous task to complete
        // if there is an error, we swallow so as to not block the queue
        try {
          await task
        } catch {
          // do nothing
        }
        // execute the current task
        return code()
      })()
      // we replace the existing task, appending the new piece of execution to it
      // so the next task will have to wait for this one to finish
      return task
    },
  }
}

const { mutex } = makeMutex()

export default class OpenAIAPI {
  constructor(private readonly papi: ChatGPT) {}

  authMethod: 'login-window' | 'extension' = 'login-window'

  private accessToken: string

  private cfChallengeInProgress: boolean

  private cfChallenge = async () => {
    this.cfChallengeInProgress = true
    console.log('cf challenge')
    console.time('cf challenge')
    try {
      // todo: add timeout or this will never resolve
      await texts.openBrowserWindow(this.papi.accountID, {
        url: ENDPOINT,
        userAgent: ELECTRON_UA,
        runJSOnLaunch: CLOSE_ON_AUTHENTICATED_JS,
        runJSOnNavigate: CLOSE_ON_AUTHENTICATED_JS,
      })
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
        Referer: 'https://chat.openai.com/',
        // ...this.headers,
      },
      ...optOverrides,
    }
    const url = `${ENDPOINT}${pathname}`
    console.log('call nativefetch', url)
    const res = await mutex(() => texts.nativeFetch(this.papi.sessionID, url, opts))
    console.log('return nativefetch', url)
    const body = Buffer.from(res.body).toString()
    if (body[0] === '<') {
      if (res.statusCode === 403 && !attempt) {
        await this.cfChallenge()
        return this.call<ResultType>(pathname, jsonBody, optOverrides, (attempt || 0) + 1)
      }
      console.log(res.statusCode, url, body)
      throw new ExpectedJSONGotHTMLError(res.statusCode, body)
    } else if (body.startsWith('Internal')) {
      console.log(res.statusCode, url, body)
      throw Error(body)
    }
    const json = JSON.parse(body)
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
      'sec-ch-ua': '"Not:A-Brand";v="99", "Chromium";v="112"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'user-agent': ELECTRON_UA,
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
      // cookie: this.jar.getCookieStringSync(url),
      referer: conversationID ? `https://chat.openai.com/c/${conversationID}` : 'https://chat.openai.com/',
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
      variant_purpose: 'none',
      history_and_training_disabled: this.papi.historyAndTrainingDisabled,
    }
    const stream = await texts.nativeFetchStream(this.papi.sessionID, url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    return stream
  }
}

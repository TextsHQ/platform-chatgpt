import { FetchOptions, texts } from '@textshq/platform-sdk'
import type { CookieJar } from 'tough-cookie'

const ENDPOINT = 'https://chat.openai.com/'

const DEFAULT_MODEL = 'text-davinci-002-render-sha'
const TIMEZONE_OFFSET_MIN = 420

export default class OpenAIAPI {
  private http = texts.createHttpClient()

  jar: CookieJar

  ua = texts.constants.USER_AGENT

  authMethod: 'login-window' | 'extension' = 'login-window'

  private accessToken: string

  private async call(pathname: string, jsonBody?: any, optOverrides?: Partial<FetchOptions>) {
    const opts: FetchOptions = {
      body: jsonBody ? JSON.stringify(jsonBody) : undefined,
      headers: {
        ...(pathname.startsWith('backend-api') && { Authorization: `Bearer ${this.accessToken}` }),
        ...(jsonBody && { 'Content-Type': 'application/json' }),
        Referer: 'https://chat.openai.com/chat',
        ...this.headers,
      },
      cookieJar: this.jar,
      ...optOverrides,
    }
    const res = await this.http.requestAsString(`${ENDPOINT}${pathname}`, opts)
    if (res.body[0] === '<') {
      console.log(res.statusCode, res.body)
      const [, title] = /<title[^>]*>(.*?)<\/title>/.exec(res.body) || []
      throw Error(`expected json, got html, status code=${res.statusCode}, title=${title}`)
    }
    const json = JSON.parse(res.body)
    return json
  }

  async session() {
    const json = await this.call('api/auth/session')
    this.accessToken = json.accessToken
    return json
  }

  models = () => this.call('backend-api/models')

  conversations = (offset = 0, limit = 20) =>
    this.call('backend-api/conversations', undefined, { searchParams: { offset, limit } })

  conversation = (id: string) =>
    this.call(`backend-api/conversation/${id}`)

  patchConversation = (id: string, body: any) =>
    this.call(`backend-api/conversation/${id}`, body, { method: 'PATCH' })

  genTitle = (convID: string, messageID: string) =>
    this.call(`backend-api/conversation/gen_title/${convID}`, { message_id: messageID, model: DEFAULT_MODEL })

  get headers() {
    return {
      accept: '*/*',
      'accept-language': 'en',
      'sec-ch-ua': '"Google Chrome";v="111", "Not(A:Brand";v="8", "Chromium";v="111"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'user-agent': this.ua,
    }
  }

  async postMessage(convID: string | undefined, guid: string, text: string, parentMessageID: string) {
    const url = `${ENDPOINT}backend-api/conversation`
    const headers = {
      ...this.headers,
      accept: 'text/event-stream',
      authorization: `Bearer ${this.accessToken}`,
      'content-type': 'application/json',
      cookie: this.jar.getCookieStringSync(url),
      referer: convID ? `https://chat.openai.com/chat/${convID}` : 'https://chat.openai.com/chat',
    }
    const body = {
      action: 'next',
      messages: [{
        id: guid,
        author: { role: 'user' },
        role: 'user',
        content: { content_type: 'text', parts: [text] },
      }],
      conversation_id: convID,
      parent_message_id: parentMessageID,
      model: DEFAULT_MODEL,
      timezone_offset_min: TIMEZONE_OFFSET_MIN,
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

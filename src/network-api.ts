import { texts } from '@textshq/platform-sdk'
import type { CookieJar } from 'tough-cookie'

const ENDPOINT = 'https://chat.openai.com/'

export default class OpenAIAPI {
  private http = texts.createHttpClient()

  jar: CookieJar

  ua = texts.constants.USER_AGENT

  authMethod: 'login-window' | 'extension' = 'login-window'

  private accessToken: string

  async fetchJSON(pathname: string) {
    const res = await this.http.requestAsString(`${ENDPOINT}${pathname}`, {
      headers: this.headers,
      cookieJar: this.jar,
    })
    if (res.body[0] === '<') {
      console.log(res.statusCode, res.body)
      const [, title] = /<title[^>]*>(.*?)<\/title>/.exec(res.body) || []
      throw Error(`expected json, got html, status code=${res.statusCode}, title=${title}`)
    }
    const json = JSON.parse(res.body)
    return json
  }

  async session() {
    const json = await this.fetchJSON('api/auth/session')
    this.accessToken = json.accessToken
    return json
  }

  get headers() {
    return {
      accept: '*/*',
      'accept-language': 'en',
      'sec-ch-ua': '"Not?A_Brand";v="8", "Chromium";v="108", "Google Chrome";v="108"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'user-agent': this.ua,
    }
  }

  async postMessage(convID: string, guid: string, text: string, parentMessageID: string) {
    const url = `${ENDPOINT}backend-api/conversation`
    const stream = await texts.fetchStream(url, {
      method: 'POST',
      cookieJar: this.jar,
      headers: {
        ...this.headers,
        Accept: 'text/event-stream',
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        'x-openai-assistant-app-id': '',
        Cookie: this.jar.getCookieStringSync(url),
      },
      body: JSON.stringify({
        action: 'next',
        conversation_id: convID,
        messages: [{ id: guid, role: 'user', content: { content_type: 'text', parts: [text] } }],
        model: 'text-davinci-002-render',
        parent_message_id: parentMessageID,
      }),
    })
    return stream
  }
}

import { Message, MessageBehavior, TextEntity, Thread, ThreadID, User } from '@textshq/platform-sdk'
import { tryParseJSON } from '@textshq/platform-sdk/dist/json'
import { ChatGPTConv, ChatGPTMessage, Model } from './interfaces'

const OPENAI_SVG_DATA_URI = 'data:image/svg+xml;utf8,<svg width="1em" height="1em" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M14.949 6.547a3.938 3.938 0 00-.348-3.273 4.108 4.108 0 00-4.4-1.934A4.105 4.105 0 008.423.2 4.153 4.153 0 006.305.086a4.12 4.12 0 00-1.891.948 4.039 4.039 0 00-1.158 1.753 4.073 4.073 0 00-1.563.679A4.009 4.009 0 00.554 4.72a3.988 3.988 0 00.502 4.731 3.936 3.936 0 00.346 3.274 4.11 4.11 0 004.402 1.933c.382.425.852.764 1.377.995a4.093 4.093 0 001.67.346c1.78.002 3.358-1.132 3.901-2.804a4.077 4.077 0 001.563-.68 4.012 4.012 0 001.14-1.253 3.994 3.994 0 00-.506-4.716zm-6.098 8.406a3.05 3.05 0 01-1.944-.694l.096-.054 3.23-1.838a.534.534 0 00.265-.455v-4.49l1.366.778a.048.048 0 01.025.035v3.722c-.003 1.653-1.361 2.992-3.037 2.996zm-6.529-2.75a2.946 2.946 0 01-.361-2.01l.096.057L5.29 12.09a.527.527 0 00.527 0l3.949-2.246v1.555a.053.053 0 01-.022.041L6.473 13.3c-1.454.826-3.311.335-4.15-1.098zm-.85-6.94A3.022 3.022 0 013.07 3.95v3.784a.506.506 0 00.262.451l3.93 2.237-1.366.779a.051.051 0 01-.048 0L2.585 9.342a2.98 2.98 0 01-1.113-4.094v.016zm11.216 2.571L8.746 5.576l1.362-.776a.052.052 0 01.048 0l3.265 1.861c.499.284.906.703 1.173 1.206a2.961 2.961 0 01-.27 3.2c-.349.452-.82.798-1.36.997V8.279a.521.521 0 00-.276-.445zm1.36-2.015l-.097-.057-3.226-1.854a.53.53 0 00-.53 0L6.248 6.153V4.598a.044.044 0 01.019-.04l3.265-1.859a3.074 3.074 0 013.257.14c.474.325.844.778 1.066 1.303.223.526.29 1.103.191 1.664v.013zM5.503 8.575L4.138 7.8a.054.054 0 01-.025-.038V4.049c0-.569.166-1.127.476-1.607.31-.48.752-.863 1.275-1.105a3.078 3.078 0 013.234.41l-.096.054-3.23 1.838a.534.534 0 00-.265.455l-.003 4.481zm.742-1.577l1.758-1 1.762 1v2l-1.755 1-1.762-1-.003-2z" fill="currentColor"/></svg>'

const participants = {
  hasMore: false,
  items: [
    {
      id: 'chatgpt',
      fullName: 'ChatGPT',
      imgURL: OPENAI_SVG_DATA_URI,
    },
  ],
}

export function mapModel(model: Model): User {
  return {
    id: model.slug,
    fullName: model.title,
    imgURL: OPENAI_SVG_DATA_URI,
  }
}

function getTextEntities(text: string, isPlugin: boolean): TextEntity {
  if (isPlugin) {
    return {
      from: 0,
      to: text.length,
      code: true,
      pre: true,
      // codeLanguage: text[0] === '{' ? 'javascript' : undefined,
    }
  }
  return {
    from: 0,
    to: text.length,
    markdown: text,
  }
}

export function mapMessage(message: ChatGPTMessage, currentUserID: string): Message {
  if (!message.message?.create_time) return
  const textHeading = (() => {
    if (message.message.recipient !== 'all' && message.message.author.role === 'assistant') return `Request to ${message.message.recipient?.split('.', 1)?.[0]}`
    if (message.message.author.role === 'tool') return `Response from ${message.message.author.name?.split('.', 1)?.[0]}`
  })()
  const text = (() => {
    const txt = (() => {
      const { content } = message.message
      switch (content?.content_type) {
        case 'text':
          return content.parts?.join('\n')
        case 'code':
        case 'tether_browsing_code':
        case 'execution_output':
          return content.text
        case 'system_error':
          return content.text
        case 'system_message':
          return content.text
        case 'tether_browsing_display':
          return content.result
        case 'tether_quote':
          return content.text
        default:
      }
    })()
    if (textHeading) {
      const json = tryParseJSON(txt)
      if (json) return JSON.stringify(json, null, 2)
    }
    return txt
  })()
  const textAttributes = text
    ? { entities: [getTextEntities(text, !!textHeading)] }
    : undefined
  const isSender = message.message.author.role === 'user'
  const modelSlug = message.message?.metadata.model_slug
  return {
    _original: JSON.stringify(message),
    id: message.id ?? message.message.id,
    timestamp: new Date(message.message.create_time * 1000),
    textHeading,
    senderID: isSender
      ? currentUserID
      : {
        'text-davinci-002-plugins': 'chatgpt',
        'text-davinci-002-render-sha': 'chatgpt',
        'text-davinci-002-render-paid': 'chatgpt',
        'gpt-4': 'chatgpt',
      }[modelSlug] ?? 'chatgpt',
    isSender,
    text,
    textAttributes,
    isHidden: !text,
    behavior: MessageBehavior.KEEP_READ,
    extra: { modelSlug },
  }
}

export function mapThread(conv: ChatGPTConv, currentUserID: string, fallbackID?: ThreadID): Thread {
  return {
    _original: JSON.stringify(conv),
    id: conv.id ?? fallbackID,
    title: conv.title,
    type: 'single',
    timestamp: new Date(conv.create_time),
    messages: {
      items: !conv.mapping
        ? []
        : Object.values(conv.mapping)
          .map(m => mapMessage(m, currentUserID))
          .filter(Boolean),
      hasMore: true,
    },
    participants,
    isUnread: false,
    isReadOnly: false,
  }
}

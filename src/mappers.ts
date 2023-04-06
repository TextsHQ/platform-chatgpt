import { Message, MessageBehavior, TextAttributes, TextEntity, Thread, ThreadID, User } from '@textshq/platform-sdk'

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

export type Model = {
  slug: string
  title: string
  max_tokens: number
  description: string
  tags: string[]
  enabled_tools: string[]
  qualitative_properties: any
}

export function mapModel(model: Model): User {
  return {
    id: model.slug,
    fullName: model.title,
    imgURL: OPENAI_SVG_DATA_URI,
  }
}

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

export function mapMessage(message: any, currentUserID: string): Message {
  if (!message.message) return
  const text = message.message.content?.parts.join('\n')
  const isSender = message.message.author.role === 'user'
  const model_slug = message.message?.metadata.model_slug
  return {
    _original: JSON.stringify(message),
    id: message.id ?? message.message.id,
    timestamp: new Date(message.message.create_time * 1000),
    senderID: isSender ? currentUserID : {
      'text-davinci-002-render-sha': 'chatgpt',
      'text-davinci-002-render-paid': 'chatgpt',
      'gpt-4': 'chatgpt',
    }[model_slug],
    isSender,
    text,
    textAttributes: text ? parseTextAttributes(text) : undefined,
    isHidden: !text,
    behavior: MessageBehavior.KEEP_READ,
    extra: {
      model_slug,
    },
  }
}

export function mapThread(conv: any, currentUserID: string, fallbackID?: ThreadID): Thread {
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

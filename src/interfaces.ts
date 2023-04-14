export interface Model {
  slug: string
  title: string
  max_tokens: number
  description: string
  tags: string[]
  enabled_tools: string[]
  qualitative_properties: any
}

interface Author {
  role: 'user' | 'assistant' | 'tool'
  name?: string
}

export interface ChatGPTMessage {
  id?: string
  message?: {
    id?: string
    recipient?: string
    author: Author
    content?: {
      content_type: 'text'
      parts: string[]
    } | {
      content_type: 'code' | 'tether_browsing_code' | 'execution_output'
      language: string
      text: string
    } | {
      content_type: 'tether_quote'
      url: string
      domain: string
      text: string
      title: string
    } | {
      content_type: 'tether_browsing_display'
      result: string
      summary: string
    } | {
      content_type: 'system_error'
      text: string
    } | {
      content_type: 'system_message'
      text: string
    }
    create_time?: number
    metadata?: {
      model_slug?: string
    }
  }
}

export interface ChatGPTConv {
  id: string
  title: string
  create_time: string | number
  update_time: string | number
  mapping: Record<string, ChatGPTMessage>
  plugin_ids?: string[]
}

interface Manifest {
  schema_version: string
  name_for_model: string
  name_for_human: string
  description_for_model: string
  description_for_human: string
  auth: {
    type: string
    instructions?: string
    authorization_type?: string
    verification_tokens?: {
      openai: string
    }
    client_url?: string
    scope?: string
    authorization_url?: string
    authorization_content_type?: string
  }
  api: {
    type: string
    url: string
    has_user_authentication: boolean | null
  }
  logo_url: string
  contact_email: string
  legal_info_url: string
}

interface UserSettings {
  is_installed: boolean
  is_authenticated: boolean
}

export interface Plugin {
  id: string
  domain: string
  namespace: string
  status: string
  manifest: Manifest
  oauth_client_id: string | null
  user_settings: UserSettings
}

import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { fetchOllamaModels } from '../providers/ollama-tags.js'
import { fetchLlamaCppModels } from '../providers/llamacpp-models.js'

export interface ProviderOption {
  providerKey: string
  model: string
  label: string
}

interface ModelPickerProps {
  options: ProviderOption[]
  currentModel: string
  currentProviderKey?: string
  onSelect: (option: ProviderOption) => void
  onCancel: () => void
  ollamaBaseUrl?: string
  llamacppBaseUrl?: string
  llamacppApiKey?: string
}

export function ModelPicker({
  options,
  currentModel,
  currentProviderKey,
  onSelect,
  onCancel,
  ollamaBaseUrl,
  llamacppBaseUrl,
  llamacppApiKey,
}: ModelPickerProps) {
  const [cursor, setCursor] = useState(0)
  const [liveOllamaModels, setLiveOllamaModels] = useState<string[]>([])
  const [liveLlamaCppModels, setLiveLlamaCppModels] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    if (ollamaBaseUrl) {
      fetchOllamaModels(ollamaBaseUrl).then(models => {
        if (!cancelled) setLiveOllamaModels(models)
      })
    }
    if (llamacppBaseUrl) {
      fetchLlamaCppModels(llamacppBaseUrl, llamacppApiKey).then(models => {
        if (!cancelled) setLiveLlamaCppModels(models)
      })
    }
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Merge: configured options first, then live discovery rows from each backend.
  // Each live section is appended only if it has new entries not already configured.
  const { mergedOptions, sectionHeaders } = useMemo(() => {
    const existing = new Set(options.map(o => `${o.providerKey}/${o.model}`))
    const merged: ProviderOption[] = [...options]
    const headers = new Map<number, string>()

    const liveOllamaRows: ProviderOption[] = liveOllamaModels
      .filter(name => !existing.has(`ollama/${name}`))
      .map(name => ({
        providerKey: 'ollama',
        model: name,
        label: `ollama: ${name}`,
      }))
    if (liveOllamaRows.length > 0) {
      headers.set(merged.length, '── ollama (live) ──')
      merged.push(...liveOllamaRows)
    }

    const liveLlamaCppRows: ProviderOption[] = liveLlamaCppModels
      .filter(name => !existing.has(`llamacpp/${name}`))
      .map(name => ({
        providerKey: 'llamacpp',
        model: name,
        label: `llamacpp: ${name}`,
      }))
    if (liveLlamaCppRows.length > 0) {
      headers.set(merged.length, '── llamacpp (live) ──')
      merged.push(...liveLlamaCppRows)
    }

    return { mergedOptions: merged, sectionHeaders: headers }
  }, [options, liveOllamaModels, liveLlamaCppModels])

  useInput((input, key) => {
    if (key.upArrow) setCursor(c => Math.max(0, c - 1))
    if (key.downArrow) setCursor(c => Math.min(mergedOptions.length - 1, c + 1))
    if (key.return && mergedOptions.length > 0) onSelect(mergedOptions[cursor])
    if (key.escape || input === 'q') onCancel()
  })

  if (mergedOptions.length === 0) {
    return React.createElement(Text, { color: 'yellow' }, 'No providers configured.')
  }

  const children: React.ReactNode[] = [
    React.createElement(
      Text,
      { key: 'header', bold: true },
      'Switch model (\u2191\u2193 select, Enter confirm, Esc cancel)',
    ),
  ]

  mergedOptions.forEach((opt, i) => {
    const headerLabel = sectionHeaders.get(i)
    if (headerLabel) {
      children.push(
        React.createElement(
          Text,
          { key: `section-${i}`, dimColor: true },
          headerLabel,
        ),
      )
    }
    const selected = i === cursor
    // Match by providerKey + model so multiple backends serving the same
    // model name don't all label themselves "(current)".
    const isCurrent = currentProviderKey
      ? opt.providerKey === currentProviderKey && opt.model === currentModel
      : opt.model === currentModel
    const suffix = isCurrent ? ' (current)' : ''
    children.push(
      React.createElement(
        Text,
        {
          key: `${opt.providerKey}/${opt.model}`,
          bold: selected,
          dimColor: !selected,
        },
        `${selected ? '>' : ' '} ${opt.label}${suffix}`,
      ),
    )
  })

  return React.createElement(Box, { flexDirection: 'column' }, ...children)
}

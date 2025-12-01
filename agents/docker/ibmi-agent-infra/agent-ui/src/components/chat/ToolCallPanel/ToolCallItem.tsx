'use client'

import { useState } from 'react'
import { ToolCall } from '@/types/os'
import { cn } from '@/lib/utils'
import Icon from '@/components/ui/icon'

interface ToolCallItemProps {
  toolCall: ToolCall
  index: number
  isInProgress?: boolean
}

export function ToolCallItem({ toolCall, index, isInProgress = false }: ToolCallItemProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  const hasError = toolCall.tool_call_error
  const duration = toolCall.metrics?.duration ?? toolCall.metrics?.time
  const hasDuration = typeof duration === 'number'
  const executionTime = hasDuration ? `${duration.toFixed(2)}s` : null

  return (
    <div
      className={cn(
        'rounded-lg border transition-colors',
        hasError
          ? 'border-destructive/50 bg-destructive/10'
          : isInProgress
            ? 'border-warning/50 bg-warning/10'
            : 'border-border bg-background-secondary/50'
      )}
    >
      {/* Header - Clickable to expand/collapse */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center justify-between p-3 text-left transition-colors hover:bg-background-secondary/80"
      >
        <div className="flex items-center gap-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent text-xs font-medium text-primary">
            {index + 1}
          </span>
          <div className="flex flex-col">
            <span className="font-dmmono text-sm font-medium uppercase text-primary">
              {toolCall.tool_name}
            </span>
            {executionTime && (
              <span className="text-xs text-secondary">{executionTime}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {hasError ? (
            <span className="rounded-full bg-destructive/20 px-2 py-0.5 text-xs text-destructive">
              Error
            </span>
          ) : isInProgress ? (
            <span className="flex items-center gap-1 rounded-full bg-warning/20 px-2 py-0.5 text-xs text-warning">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
              Running
            </span>
          ) : (toolCall.result || toolCall.content) ? (
            <span className="rounded-full bg-positive/20 px-2 py-0.5 text-xs text-positive">
              Success
            </span>
          ) : null}
          <Icon
            type={isExpanded ? 'chevron-up' : 'chevron-down'}
            size="xs"
            className="text-secondary"
          />
        </div>
      </button>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="border-t border-border p-3">
          {/* Tool Call ID */}
          {toolCall.tool_call_id && (
            <div className="mb-3">
              <p className="mb-1 text-xs font-medium uppercase text-secondary">
                Tool Call ID
              </p>
              <code className="block rounded bg-background px-2 py-1 font-dmmono text-xs text-primary/80">
                {toolCall.tool_call_id}
              </code>
            </div>
          )}

          {/* Arguments */}
          <div className="mb-3">
            <p className="mb-1 text-xs font-medium uppercase text-secondary">
              Arguments
            </p>
            <pre className="max-h-48 overflow-auto rounded bg-background p-2 font-dmmono text-xs text-primary/80">
              {JSON.stringify(toolCall.tool_args, null, 2)}
            </pre>
          </div>

          {/* Metrics / Duration */}
          {hasDuration && (
            <div className="mb-3">
              <p className="mb-1 text-xs font-medium uppercase text-secondary">
                Duration
              </p>
              <div className="flex items-center gap-2 rounded bg-background px-2 py-1.5">
                <span className="text-xs text-primary">
                  {duration!.toFixed(3)}s
                </span>
                <span className="text-xs text-secondary">
                  ({(duration! * 1000).toFixed(0)}ms)
                </span>
              </div>
            </div>
          )}

          {/* Response */}
          <div>
            <p className="mb-1 text-xs font-medium uppercase text-secondary">
              Response
            </p>
            <pre
              className={cn(
                'max-h-64 min-h-[2rem] overflow-auto rounded border p-2 font-dmmono text-xs whitespace-pre-wrap break-words',
                hasError
                  ? 'border-destructive/30 bg-destructive/10 text-destructive'
                  : isInProgress
                    ? 'border-warning/30 bg-warning/5 text-primary'
                    : 'border-border bg-[#1a1a1c] text-primary'
              )}
            >
              {(() => {
                // Show running indicator for in-progress tool calls
                if (isInProgress) {
                  return (
                    <span className="flex items-center gap-2 text-warning">
                      <span className="h-2 w-2 animate-pulse rounded-full bg-warning" />
                      Executing tool...
                    </span>
                  )
                }
                // Check result field first (API response), then content field (legacy)
                const response = toolCall.result || toolCall.content
                if (!response) {
                  return <span className="text-secondary/50 italic">Pending response...</span>
                }
                // Try to parse and pretty-print JSON
                if (typeof response === 'string') {
                  try {
                    const parsed = JSON.parse(response)
                    return JSON.stringify(parsed, null, 2)
                  } catch {
                    return response
                  }
                }
                return String(response)
              })()}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}

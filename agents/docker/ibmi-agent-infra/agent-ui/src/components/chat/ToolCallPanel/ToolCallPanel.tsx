'use client'

import { useStore } from '@/store'
import { cn } from '@/lib/utils'
import Icon from '@/components/ui/icon'
import { ToolCallItem } from './ToolCallItem'

export function ToolCallPanel() {
  const toolCallPanelOpen = useStore((state) => state.toolCallPanelOpen)
  const setToolCallPanelOpen = useStore((state) => state.setToolCallPanelOpen)
  const selectedToolCalls = useStore((state) => state.selectedToolCalls)
  const streamingToolCalls = useStore((state) => state.streamingToolCalls)
  const inProgressToolCallIds = useStore((state) => state.inProgressToolCallIds)
  const isStreaming = useStore((state) => state.isStreaming)

  // Use streaming tool calls when streaming is active and there are any,
  // otherwise fall back to selected tool calls
  const toolCalls = isStreaming && streamingToolCalls.length > 0
    ? streamingToolCalls
    : selectedToolCalls

  if (!toolCallPanelOpen) return null

  return (
    <div
      className={cn(
        'flex h-full w-[400px] flex-shrink-0 flex-col border-l border-border bg-background',
        'animate-in slide-in-from-right duration-200'
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border p-4">
        <div className="flex items-center gap-2">
          <Icon
            type="hammer"
            size="sm"
            className="rounded-lg bg-background-secondary p-1"
          />
          <h2 className="font-medium text-primary">Tool Calls</h2>
          <span className="rounded-full bg-accent px-2 py-0.5 text-xs text-primary">
            {toolCalls.length}
          </span>
          {isStreaming && inProgressToolCallIds.size > 0 && (
            <span className="flex items-center gap-1 rounded-full bg-warning/20 px-2 py-0.5 text-xs text-warning">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
              Running
            </span>
          )}
        </div>
        <button
          onClick={() => setToolCallPanelOpen(false)}
          className="rounded-md p-1 transition-colors hover:bg-background-secondary"
          aria-label="Close tool calls panel"
        >
          <Icon type="x" size="xs" className="text-secondary" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {toolCalls.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <Icon
              type="hammer"
              size="md"
              className="mb-3 text-secondary opacity-50"
            />
            <p className="text-sm text-secondary">No tool calls to display</p>
            <p className="mt-1 text-xs text-secondary/60">
              Tool calls will appear here when the agent uses tools
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {toolCalls.map((toolCall, index) => {
              const toolCallId = toolCall.tool_call_id ||
                `${toolCall.tool_name}-${toolCall.created_at}`
              const isInProgress = inProgressToolCallIds.has(toolCallId)
              return (
                <ToolCallItem
                  key={toolCallId || `${toolCall.tool_name}-${index}`}
                  toolCall={toolCall}
                  index={index}
                  isInProgress={isInProgress}
                />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

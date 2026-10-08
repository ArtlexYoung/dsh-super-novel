/** Public DSH controls; icon exports changed from fixed sizes to regular strokes in 0.2. */
import { createElement } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'

export const { Button, Input, Tag } = primitives

function icon(legacy: string, current: string, size: number) {
  const Component = primitives[current] ?? primitives[legacy]
  if (!Component) throw new Error(`Missing DSH icon: ${current}`)
  return props => createElement(Component, { size, ...props })
}

export const IconPlusOutline16 = icon('IconPlusOutline16', 'IconPlusOutlineRegular', 16)
export const IconEditOutline16 = icon('IconEditOutline16', 'IconEditOutlineRegular', 16)
export const IconRefreshOutline16 = icon('IconRefreshOutline16', 'IconRefreshOutlineRegular', 16)
export const IconCheckOutline16 = icon('IconCheckOutline16', 'IconCheckOutlineRegular', 16)
export const IconCloseOutline16 = icon('IconCloseOutline16', 'IconCloseOutlineRegular', 16)
export const IconSearchOutline16 = icon('IconSearchOutline16', 'IconSearchOutlineRegular', 16)
export const IconSparkle16 = icon('IconSparkle16', 'IconSparkleRegular', 16)
export const IconChevronUpOutline14 = icon('IconChevronUpOutline14', 'IconChevronUpOutlineRegular', 14)
export const IconChevronDownOutline14 = icon('IconChevronDownOutline14', 'IconChevronDownOutlineRegular', 14)
export const IconChevronLeftOutline14 = icon('IconChevronLeftOutline14', 'IconChevronLeftOutlineRegular', 14)
export const IconChevronRightOutline14 = icon('IconChevronRightOutline14', 'IconChevronRightOutlineRegular', 14)

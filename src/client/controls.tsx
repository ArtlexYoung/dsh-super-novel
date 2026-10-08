import React from 'react'
import { IconChevronDownOutline14 } from './primitives.js'

/** There is no shared Select atom; keep native semantics with the DSH field appearance. */
export function Select({ children, ...props }) {
  return <span className="sn-select"><select {...props}>{children}</select><IconChevronDownOutline14 /></span>
}

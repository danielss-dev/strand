import { forwardRef, type SelectHTMLAttributes } from 'react';

import { Icon } from './Icon';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  containerClassName?: string;
}

/**
 * Native select behavior with Strand's shared dropdown affordance. The icon is
 * presentation-only, so keyboard, form, focus, and accessibility semantics
 * remain owned by the underlying select element.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({
  className = '',
  containerClassName = '',
  children,
  ...props
}, ref) {
  return (
    <span className={`select-control ${containerClassName}`.trim()}>
      <select ref={ref} className={className} {...props}>{children}</select>
      <Icon className="select-control-chevron" name="chev-down" size={14} aria-hidden="true" />
    </span>
  );
});

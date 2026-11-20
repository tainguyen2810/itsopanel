import { createContext, useContext, type AnchorHTMLAttributes, type ComponentType } from 'react';

export type AppLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };

/**
 * Link nội bộ của component nền (sidebar, breadcrumb…). Mặc định là thẻ <a>; app có router
 * cung cấp Link của router để điều hướng không tải lại trang.
 */
export const AppLinkContext = createContext<ComponentType<AppLinkProps>>(function PlainLink(props) {
  return <a {...props} />;
});

export function useAppLink() {
  return useContext(AppLinkContext);
}

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Ghép class Tailwind (chuẩn shadcn/ui). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

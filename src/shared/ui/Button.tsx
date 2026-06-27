import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
  variant?: "primary" | "ghost" | "danger";
}

export function Button({ children, className = "", icon, variant = "primary", ...props }: ButtonProps) {
  return (
    <button className={`button button-${variant} ${className}`.trim()} type="button" {...props}>
      {icon}
      <span>{children}</span>
    </button>
  );
}


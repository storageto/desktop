import { ReactNode, useId } from "react";
import { Tooltip as ReactTooltip } from "react-tooltip";

interface TooltipProps {
  text: string;
  children: ReactNode;
  position?: "top" | "bottom" | "left" | "right";
}

export function Tooltip({ text, children, position = "top" }: TooltipProps) {
  const id = useId();

  return (
    <>
      <div
        className="inline-flex"
        data-tooltip-id={id}
        data-tooltip-content={text}
        data-tooltip-place={position}
      >
        {children}
      </div>
      <ReactTooltip
        id={id}
        className="!bg-[#1c1917] !border !border-[#292524] !rounded !px-2 !py-1 !text-xs !font-medium !text-white !opacity-100 !shadow-lg !z-[9999]"
        classNameArrow="!border-[#292524]"
        delayShow={0}
        delayHide={0}
        noArrow={false}
      />
    </>
  );
}

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const DISALLOWED_ELEMENTS = ["a", "img"];

export interface ReleaseNotesMarkdownProps {
  content: string;
}

export default function ReleaseNotesMarkdown({ content }: ReleaseNotesMarkdownProps) {
  return (
    <div className="update-release-markdown">
      <ReactMarkdown
        disallowedElements={DISALLOWED_ELEMENTS}
        remarkPlugins={[remarkGfm]}
        skipHtml
        unwrapDisallowed
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

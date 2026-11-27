import React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

const components = {
  h1: "h2",
  img: ({alt}) => alt || null,
  table: ({children}) => <div className="answer-table"><table>{children}</table></div>,
};
export default function AssistantResponse({text}) {
  return <div className="assistant-answer">
    <Markdown remarkPlugins={[remarkGfm]} skipHtml components={components}>{text}</Markdown>
  </div>;
}

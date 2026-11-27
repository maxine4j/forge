import type { AgentRequest, AgentReply } from "@forge/contracts/agents";
import { useId, useState } from "react";

export const RequestCard = ({
	request,
	busy,
	reply,
	drafts,
}: {
	request: AgentRequest;
	busy: boolean;
	reply: (input: AgentReply) => void;
	drafts?: Map<string, string>;
}) => {
	const [localAnswers, setAnswers] = useState<Record<string, string>>(() =>
		Object.fromEntries(
			request.questions.map((question) => [
				question.id,
				drafts?.get(`request:${request.id}:${question.id}`) ?? "",
			]),
		),
	);
	const answers = Object.fromEntries(
		request.questions.map((question) => [
			question.id,
			drafts?.get(`request:${request.id}:${question.id}`) ?? localAnswers[question.id] ?? "",
		]),
	);
	const answer = (id: string, value: string) => {
		setAnswers((current) => ({ ...current, [id]: value }));
		drafts?.set(`request:${request.id}:${id}`, value);
	};
	const formId = useId();
	return (
		<form
			className='agent-request'
			onSubmit={(event) => {
				event.preventDefault();
				reply({ requestId: request.id, answers });
			}}
		>
			<h4>
				{request.kind === "input"
					? "Input requested"
					: request.kind === "file"
						? "File change approval"
						: "Command approval"}
			</h4>
			<pre>{request.description}</pre>
			{request.questions.map((question, index) => (
				<div key={question.id} className='agent-question'>
					<label htmlFor={`${formId}-${index}`}>{question.question}</label>
					{question.secret ? (
						<input
							id={`${formId}-${index}`}
							type='password'
							required
							maxLength={4000}
							value={answers[question.id] ?? ""}
							onChange={(event) => answer(question.id, event.target.value)}
							disabled={busy}
						/>
					) : (
						<textarea
							id={`${formId}-${index}`}
							required
							maxLength={4000}
							value={answers[question.id] ?? ""}
							onChange={(event) => answer(question.id, event.target.value)}
							disabled={busy}
							rows={2}
						/>
					)}
					{!question.secret && (
						<div className='agent-actions'>
							{question.options.map((option) => (
								<button
									key={option}
									type='button'
									disabled={busy}
									onClick={() => answer(question.id, option)}
								>
									{option}
								</button>
							))}
						</div>
					)}
				</div>
			))}
			<div className='agent-actions'>
				{request.kind === "input" ? (
					<button disabled={busy || request.questions.some((question) => !answers[question.id]?.trim())}>
						Submit answers
					</button>
				) : (
					<>
						<button
							type='button'
							disabled={busy}
							onClick={() => reply({ requestId: request.id, decision: "accept" })}
						>
							Allow once
						</button>
						<button
							type='button'
							disabled={busy}
							onClick={() => reply({ requestId: request.id, decision: "decline" })}
						>
							Decline
						</button>
					</>
				)}
			</div>
		</form>
	);
};

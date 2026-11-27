export const PlanReviewControls = ({ busy, approve }: { busy: boolean; approve: () => void }) => (
	<button type='button' className='primary' disabled={busy} onClick={approve}>
		Approve plan
	</button>
);

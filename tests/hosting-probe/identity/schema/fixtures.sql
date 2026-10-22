-- Synthetic case content for client A (GRS-108). Each value carries a marker the runner looks for: a refusal must
-- contain none of a case's markers, and an allowed read must contain its own.
INSERT INTO cases (id, title) VALUES ('case-1', 'Synthetic matter one CC108-CASE1-META'), ('case-2', 'Synthetic matter two CC108-CASE2-META');
INSERT INTO documents (case_id, id, title, body) VALUES
	('case-1', 'doc-1', 'Synthetic letter CC108-CASE1-META', 'Synthetic extracted text CC108-CASE1-TEXT'),
	('case-2', 'doc-2', 'Synthetic invoice CC108-CASE2-META', 'Synthetic extracted text CC108-CASE2-TEXT');

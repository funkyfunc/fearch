title: Okapi BM25 - Wikipedia
method: main
---
In [information retrieval](https://en.wikipedia.org/wiki/Information_retrieval "Information retrieval"), **Okapi BM25** (*BM* is an abbreviation of *best matching*) is a [ranking function](https://en.wikipedia.org/wiki/Ranking_function "Ranking function") used by [search engines](https://en.wikipedia.org/wiki/Search_engine "Search engine") to estimate the [relevance](https://en.wikipedia.org/wiki/Relevance_\(information_retrieval\) "Relevance (information retrieval)") of documents to a given search query. It is based on the [probabilistic retrieval framework](https://en.wikipedia.org/wiki/Probabilistic_relevance_model "Probabilistic relevance model") developed in the 1970s and 1980s by [Stephen E. Robertson](https://en.wikipedia.org/wiki/Stephen_E._Robertson "Stephen E. Robertson"), [Karen Spärck Jones](https://en.wikipedia.org/wiki/Karen_Spärck_Jones "Karen Spärck Jones"), and others.

The name of the actual ranking function is *BM25*. The fuller name, *Okapi BM25*, includes the name of the first system to use it, which was the Okapi information retrieval system, implemented at [London](https://en.wikipedia.org/wiki/London "London")'s [City University](https://en.wikipedia.org/wiki/City_University,_London "City University, London")[[1]](#cite_note-1) in the 1980s and 1990s. BM25 and its newer variants, e.g. BM25F (a version of BM25 that can take document structure and [anchor text](https://en.wikipedia.org/wiki/Anchor_text "Anchor text") into account), represent [TF-IDF](https://en.wikipedia.org/wiki/TF-IDF "TF-IDF")-like retrieval functions used in [document retrieval](https://en.wikipedia.org/wiki/Document_retrieval "Document retrieval").[[2]](#cite_note-robertson2009-2)

## The ranking function

BM25 is a [bag-of-words](https://en.wikipedia.org/wiki/Bag_of_words_model "Bag of words model") retrieval function that ranks a set of documents based on the query terms appearing in each document, regardless of their proximity within the document. It is a family of scoring functions with slightly different components and parameters. One of the most prominent instantiations of the function is as follows.

Given a query Q, containing keywords q 1 , . . . , q n {\displaystyle q_{1},...,q_{n}} , the BM25 score of a document D is:

score ( D , Q ) = ∑ i = 1 n IDF ( q i ) ⋅ f ( q i , D ) ⋅ ( k 1 + 1 ) f ( q i , D ) + k 1 ⋅ ( 1 − b + b ⋅ | D | avgdl ) {\displaystyle {\text{score}}(D,Q)=\sum _{i=1}^{n}{\text{IDF}}(q_{i})\cdot {\frac {f(q_{i},D)\cdot (k_{1}+1)}{f(q_{i},D)+k_{1}\cdot \left(1-b+b\cdot {\frac {|D|}{\text{avgdl}}}\right)}}}

where f ( q i , D ) {\displaystyle f(q_{i},D)} is the number of times that the keyword q i {\displaystyle q_{i}} occurs in the document D, | D | {\displaystyle |D|} is the length of the document D in words, and avgdl is the average document length in the text collection from which documents are drawn. k 1 {\displaystyle k_{1}} and b are free parameters, usually chosen, in absence of an advanced optimization, as k 1 ∈ [ 1.2 , 2.0 ] {\displaystyle k_{1}\in [1.2,2.0]} and b = 0.75 {\displaystyle b=0.75} .[[3]](#cite_note-3) IDF ( q i ) {\displaystyle {\text{IDF}}(q_{i})} is the IDF ([inverse document frequency](https://en.wikipedia.org/wiki/Inverse_document_frequency "Inverse document frequency")) weight of the query term q i {\displaystyle q_{i}} . It is usually computed as:

IDF ( q i ) = ln ⁡ ( N − n ( q i ) + 0.5 n ( q i ) + 0.5 + 1 ) {\displaystyle {\text{IDF}}(q_{i})=\ln \left({\frac {N-n(q_{i})+0.5}{n(q_{i})+0.5}}+1\right)}

where N is the total number of documents in the collection, and n ( q i ) {\displaystyle n(q_{i})} is the number of documents containing q i {\displaystyle q_{i}} .

There are several interpretations for IDF and slight variations on its formula. In the original BM25 derivation, the IDF component is derived from the [Binary Independence Model](https://en.wikipedia.org/wiki/Binary_Independence_Model "Binary Independence Model").

## IDF information theoretic interpretation

Here is an interpretation from [information theory](https://en.wikipedia.org/wiki/Information_theory "Information theory"). Suppose a query term q {\displaystyle q} appears in n ( q ) {\displaystyle n(q)} documents. Then a randomly picked document D {\displaystyle D} will contain the term with probability n ( q ) N {\displaystyle {\frac {n(q)}{N}}} (where N {\displaystyle N} is again the cardinality of the set of documents in the collection). Therefore, the [information content](https://en.wikipedia.org/wiki/Information_content "Information content") of the message " D {\displaystyle D} contains q {\displaystyle q} " is:

− log ⁡ n ( q ) N = log ⁡ N n ( q ) . {\displaystyle -\log {\frac {n(q)}{N}}=\log {\frac {N}{n(q)}}.}

Now suppose we have two query terms q 1 {\displaystyle q_{1}} and q 2 {\displaystyle q_{2}} . If the two terms occur in documents entirely independently of each other, then the probability of seeing both q 1 {\displaystyle q_{1}} and q 2 {\displaystyle q_{2}} in a randomly picked document D {\displaystyle D} is:

n ( q 1 ) N ⋅ n ( q 2 ) N , {\displaystyle {\frac {n(q_{1})}{N}}\cdot {\frac {n(q_{2})}{N}},}

and the information content of such an event is:

∑ i = 1 2 log ⁡ N n ( q i ) . {\displaystyle \sum _{i=1}^{2}\log {\frac {N}{n(q_{i})}}.}

With a small variation, this is exactly what is expressed by the IDF component of BM25.

## Modifications

-   At the extreme values of the coefficient b BM25 turns into ranking functions known as **BM11** (for b = 1 {\displaystyle b=1} ) and **BM15** (for b = 0 {\displaystyle b=0} ).[[4]](#cite_note-4)
-   **BM25F**[[5]](#cite_note-5)[[2]](#cite_note-robertson2009-2) (or the **BM25 model with Extension to Multiple Weighted Fields**[[6]](#cite_note-6)) is a modification of BM25 in which the document is considered to be composed from several fields (such as headlines, main text, anchor text) with possibly different degrees of importance, term relevance saturation and length normalization. BM25F defines each type of field as a *stream*, applying a per-stream weighting to scale each stream against the calculated score.

-   **BM25+**[[7]](#cite_note-7) is an extension of BM25. BM25+ was developed to address one deficiency of the standard BM25 in which the component of term frequency normalization by document length is not properly lower-bounded; as a result of this deficiency, long documents which do match the query term can often be scored unfairly by BM25 as having a similar relevancy to shorter documents that do not contain the query term at all. The scoring formula of BM25+ only has one additional free parameter δ {\displaystyle \delta } (the default value is 1.0) as compared with BM25:

score ( D , Q ) = ∑ i = 1 n IDF ( q i ) ⋅ [ f ( q i , D ) ⋅ ( k 1 + 1 ) f ( q i , D ) + k 1 ⋅ ( 1 − b + b ⋅ | D | avgdl ) + δ ] {\displaystyle {\text{score}}(D,Q)=\sum _{i=1}^{n}{\text{IDF}}(q_{i})\cdot \left[{\frac {f(q_{i},D)\cdot (k_{1}+1)}{f(q_{i},D)+k_{1}\cdot \left(1-b+b\cdot {\frac {|D|}{\text{avgdl}}}\right)}}+\delta \right]}

## References

1.  [↑](#cite_ref-1) ["OKAPI"](https://web.archive.org/web/20231207112813/https://smcse.city.ac.uk/doc/cisr/web/okapi/okapi.html). *smcse.city.ac.uk*. Archived from [the original](https://smcse.city.ac.uk/doc/cisr/web/okapi/okapi.html) on 2023-12-07. Retrieved 2023-10-16.
2.  [1](#cite_ref-robertson2009_2-0) [2](#cite_ref-robertson2009_2-1) Stephen Robertson & Hugo Zaragoza (2009). ["The Probabilistic Relevance Framework: BM25 and Beyond"](http://dl.acm.org/citation.cfm?id=1704810). *Foundations and Trends in Information Retrieval*. **3** (4): 333–389. [doi](https://en.wikipedia.org/wiki/Doi_\(identifier\) "Doi (identifier)"):[10.1561/1500000019](https://doi.org/10.1561%2F1500000019). [S2CID](https://en.wikipedia.org/wiki/S2CID_\(identifier\) "S2CID (identifier)") [207178704](https://api.semanticscholar.org/CorpusID:207178704).
3.  [↑](#cite_ref-3) Christopher D. Manning, Prabhakar Raghavan, Hinrich Schütze. *An Introduction to Information Retrieval*, Cambridge University Press, 2009, p. 233.
4.  [↑](#cite_ref-4) ["The BM25 Weighting Scheme"](http://xapian.org/docs/bm25.html).
5.  [↑](#cite_ref-5) Hugo Zaragoza, Nick Craswell, Michael Taylor, Suchi Saria, and Stephen Robertson. [*Microsoft Cambridge at TREC-13: Web and HARD tracks.*](http://trec.nist.gov/pubs/trec13/papers/microsoft-cambridge.web.hard.pdf) In Proceedings of TREC-2004.
6.  [↑](#cite_ref-6) Robertson, Stephen; Zaragoza, Hugo; Taylor, Michael (2004-11-13). "Simple BM25 extension to multiple weighted fields". *Proceedings of the thirteenth ACM international conference on Information and knowledge management*. CIKM '04. New York, NY, USA: Association for Computing Machinery. pp. 42–49. [doi](https://en.wikipedia.org/wiki/Doi_\(identifier\) "Doi (identifier)"):[10.1145/1031171.1031181](https://doi.org/10.1145%2F1031171.1031181). [ISBN](https://en.wikipedia.org/wiki/ISBN_\(identifier\) "ISBN (identifier)") [978-1-58113-874-0](https://en.wikipedia.org/wiki/Special:BookSources/978-1-58113-874-0 "Special:BookSources/978-1-58113-874-0"). [S2CID](https://en.wikipedia.org/wiki/S2CID_\(identifier\) "S2CID (identifier)") [16628332](https://api.semanticscholar.org/CorpusID:16628332).
7.  [↑](#cite_ref-7) Yuanhua Lv and ChengXiang Zhai. [*Lower-bounding term frequency normalization.*](https://doi.org/10.1145/2063576.2063584) In Proceedings of CIKM'2011, pages 7-16.

## General references

-   Stephen E. Robertson; Steve Walker; Susan Jones; Micheline Hancock-Beaulieu & Mike Gatford (November 1994). [*Okapi at TREC-3*](http://trec.nist.gov/pubs/trec3/papers/city.ps.gz). [Proceedings of the Third Text REtrieval Conference (TREC 1994)](http://trec.nist.gov/pubs/trec3/t3_proceedings.html). Gaithersburg, USA.
-   Stephen E. Robertson; Steve Walker & Micheline Hancock-Beaulieu (November 1998). [*Okapi at TREC-7*](http://trec.nist.gov/pubs/trec7/papers/okapi_proc.pdf.gz). [Proceedings of the Seventh Text REtrieval Conference](http://trec.nist.gov/pubs/trec7/t7_proceedings.html). Gaithersburg, USA.
-   [Spärck Jones, K.](https://en.wikipedia.org/wiki/Karen_Spärck_Jones "Karen Spärck Jones"); Walker, S.; [Robertson, S. E.](https://en.wikipedia.org/wiki/Stephen_Robertson_\(computer_scientist\) "Stephen Robertson (computer scientist)") (2000). "A probabilistic model of information retrieval: Development and comparative experiments: Part 1". *Information Processing & Management*. **36** (6): 779–808. [doi](https://en.wikipedia.org/wiki/Doi_\(identifier\) "Doi (identifier)"):[10.1016/S0306-4573(00)00015-7](https://doi.org/10.1016%2FS0306-4573%2800%2900015-7).
-   [Spärck Jones, K.](https://en.wikipedia.org/wiki/Karen_Spärck_Jones "Karen Spärck Jones"); Walker, S.; [Robertson, S. E.](https://en.wikipedia.org/wiki/Stephen_Robertson_\(computer_scientist\) "Stephen Robertson (computer scientist)") (2000). "A probabilistic model of information retrieval: Development and comparative experiments: Part 2". *Information Processing & Management*. **36** (6): 809–840. [doi](https://en.wikipedia.org/wiki/Doi_\(identifier\) "Doi (identifier)"):[10.1016/S0306-4573(00)00016-9](https://doi.org/10.1016%2FS0306-4573%2800%2900016-9).
-   Stephen Robertson & Hugo Zaragoza (2009). ["The Probabilistic Relevance Framework: BM25 and Beyond"](http://dl.acm.org/citation.cfm?id=1704810). *Foundations and Trends in Information Retrieval*. **3** (4): 333–389. [doi](https://en.wikipedia.org/wiki/Doi_\(identifier\) "Doi (identifier)"):[10.1561/1500000019](https://doi.org/10.1561%2F1500000019). [S2CID](https://en.wikipedia.org/wiki/S2CID_\(identifier\) "S2CID (identifier)") [207178704](https://api.semanticscholar.org/CorpusID:207178704).

## External links

-   [Robertson, Stephen](https://en.wikipedia.org/wiki/Stephen_Robertson_\(computer_scientist\) "Stephen Robertson (computer scientist)"); Zaragoza, Hugo (2009). [*The Probabilistic Relevance Framework: BM25 and Beyond*](https://www.staff.city.ac.uk/~sbrp622/papers/foundations_bm25_review.pdf) (PDF). NOW Publishers, Inc. [ISBN](https://en.wikipedia.org/wiki/ISBN_\(identifier\) "ISBN (identifier)") [978-1-60198-308-4](https://en.wikipedia.org/wiki/Special:BookSources/978-1-60198-308-4 "Special:BookSources/978-1-60198-308-4").

Retrieved from "[https://en.wikipedia.org/w/index.php?title=Okapi_BM25&oldid=1369261401](https://en.wikipedia.org/w/index.php?title=Okapi_BM25&oldid=1369261401)"
